/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Milos Martinovic
 *
 * seatctl - a small SOME/IP client for the BMW iDrive 8 head unit (MGU), used by
 * the mm-easy-entry tool. It asks the head unit's vsomeip routing manager
 * (vsomeipd) for services by number, calls methods and subscribes to events.
 *
 * Only vsomeip_v3::runtime::get() is imported from libvsomeip3; everything else
 * goes through the virtual interfaces (runtime, application, message, payload),
 * so the binary does not depend on the library's internal symbols.
 *
 *   seatctl call SVC INST METHOD MAJOR [tcp|udp] [HEX]   one request, prints the reply
 *   seatctl send SVC INST METHOD MAJOR [tcp|udp] [HEX]   one request without a reply
 *   seatctl sub  SVC INST MAJOR GROUP EVENT[,EVENT...]   prints every notification
 *   seatctl serve                                        line protocol on stdin/stdout
 *
 * serve: each input line is "<tag> <command> <args>" with the commands above
 * (and "avail SVC INST MAJOR"); each answer starts with the tag:
 *   <tag> ok <hex>        a reply (hex may be empty)
 *   <tag> error <code>    a SOME/IP error reply (return code, hex)
 *   <tag> noreply         nothing within the timeout
 *   <tag> unavailable     the service did not show up within the timeout
 *   <tag> sent | <tag> subscribed | <tag> avail 0|1 | <tag> bad <why>
 * Notifications, from any subscription: "ev 0xSVC 0xEVENT <hex>".
 * Numbers are decimal or 0x hex. Payload hex is the SOME/IP payload, big-endian
 * as CommonAPI serializes it.
 */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <chrono>
#include <condition_variable>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#include <vsomeip/vsomeip.hpp>

namespace {

const int kWaitMs = 3000;          // availability and reply timeout
const int kRegisterMs = 5000;      // how long the routing manager may take

std::mutex out_mu;
volatile bool answered = false;    // one-shot mode: the "-" command has its answer
void out(const std::string &line) {
    std::lock_guard<std::mutex> g(out_mu);
    if (line.compare(0, 2, "- ") == 0 && line != "- subscribed") answered = true;
    fputs(line.c_str(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

std::string hex(const vsomeip::byte_t *p, vsomeip::length_t n) {
    static const char d[] = "0123456789abcdef";
    std::string s;
    s.reserve(n * 2);
    for (vsomeip::length_t i = 0; i < n; i++) {
        s.push_back(d[p[i] >> 4]);
        s.push_back(d[p[i] & 15]);
    }
    return s;
}

bool unhex(const std::string &s, std::vector<vsomeip::byte_t> &b) {
    if (s.size() % 2) return false;
    b.clear();
    for (size_t i = 0; i < s.size(); i += 2) {
        char t[3] = {s[i], s[i + 1], 0};
        char *e = nullptr;
        long v = strtol(t, &e, 16);
        if (!e || *e) return false;
        b.push_back(vsomeip::byte_t(v));
    }
    return true;
}

bool num(const std::string &s, unsigned long max, unsigned long &v) {
    if (s.empty()) return false;
    char *e = nullptr;
    v = strtoul(s.c_str(), &e, 0);
    return e && !*e && v <= max;
}

char hex4buf[16];
const char *h4(unsigned v) {
    snprintf(hex4buf, sizeof hex4buf, "0x%04x", v);
    return hex4buf;
}

struct Pending {
    std::string tag;
    std::chrono::steady_clock::time_point deadline;
};

class Client {
public:
    bool start() {
        rt_ = vsomeip::runtime::get();
        if (!rt_) return false;
        std::string name = "mm-seatctl-" + std::to_string(getpid());
        setenv("VSOMEIP_APPLICATION_NAME", name.c_str(), 0);
        app_ = rt_->create_application(name);
        if (!app_ || !app_->init()) return false;
        app_->register_state_handler([this](vsomeip::state_type_e s) {
            std::lock_guard<std::mutex> g(mu_);
            registered_ = (s == vsomeip::state_type_e::ST_REGISTERED);
            cv_.notify_all();
        });
        app_->register_message_handler(vsomeip::ANY_SERVICE, vsomeip::ANY_INSTANCE, vsomeip::ANY_METHOD,
                                       [this](const std::shared_ptr<vsomeip::message> &m) { onMessage(m); });
        worker_ = std::thread([this] { app_->start(); });
        timer_ = std::thread([this] { expire(); });
        std::unique_lock<std::mutex> l(mu_);
        return cv_.wait_for(l, std::chrono::milliseconds(kRegisterMs), [this] { return registered_; });
    }

    void stop() {
        stopping_ = true;
        if (app_) app_->stop();
        if (worker_.joinable()) worker_.join();
        if (timer_.joinable()) timer_.join();
    }

    /* request the service once, then wait for it */
    bool waitAvailable(vsomeip::service_t svc, vsomeip::instance_t inst, vsomeip::major_version_t major) {
        auto key = std::make_pair(svc, inst);
        bool ask = false;
        {
            std::lock_guard<std::mutex> g(mu_);
            if (!requested_.count(key)) {
                requested_.insert(key);
                ask = true;
            }
        }
        if (ask) {
            app_->register_availability_handler(svc, inst,
                [this](vsomeip::service_t s, vsomeip::instance_t i, bool a) {
                    {
                        std::lock_guard<std::mutex> g(mu_);
                        available_[std::make_pair(s, i)] = a;
                        cv_.notify_all();
                    }
                    std::ostringstream o;
                    o << "avail " << h4(s) << " " << i << " " << (a ? 1 : 0);
                    out(o.str());
                }, major, vsomeip::ANY_MINOR);
            app_->request_service(svc, inst, major, vsomeip::ANY_MINOR);
        }
        std::unique_lock<std::mutex> l(mu_);
        return cv_.wait_for(l, std::chrono::milliseconds(kWaitMs), [&] {
            auto it = available_.find(key);
            return it != available_.end() && it->second;
        });
    }

    void call(const std::string &tag, vsomeip::service_t svc, vsomeip::instance_t inst, vsomeip::method_t method,
              vsomeip::major_version_t major, bool reliable, const std::vector<vsomeip::byte_t> &body, bool reply) {
        if (!waitAvailable(svc, inst, major)) {
            out(tag + " unavailable");
            return;
        }
        std::shared_ptr<vsomeip::message> m = rt_->create_request(reliable);
        m->set_service(svc);
        m->set_instance(inst);
        m->set_method(method);
        m->set_interface_version(major);
        if (!reply) m->set_message_type(vsomeip::message_type_e::MT_REQUEST_NO_RETURN);
        std::shared_ptr<vsomeip::payload> p = rt_->create_payload();
        p->set_data(body);
        m->set_payload(p);
        {
            // held across send, so a fast reply finds its entry
            std::lock_guard<std::mutex> g(mu_);
            app_->send(m);
            if (reply) {
                pending_[std::make_tuple(svc, method, m->get_session())] =
                    Pending{tag, std::chrono::steady_clock::now() + std::chrono::milliseconds(kWaitMs)};
            }
        }
        if (!reply) out(tag + " sent");
    }

    void sub(const std::string &tag, vsomeip::service_t svc, vsomeip::instance_t inst, vsomeip::major_version_t major,
             vsomeip::eventgroup_t group, const std::vector<vsomeip::event_t> &events) {
        std::set<vsomeip::eventgroup_t> groups{group};
        for (vsomeip::event_t e : events)
            app_->request_event(svc, inst, e, groups, vsomeip::event_type_e::ET_FIELD,
                                vsomeip::reliability_type_e::RT_UNKNOWN);
        if (!waitAvailable(svc, inst, major)) {
            // the subscription stays asked for: it starts when the service shows up
            out(tag + " unavailable");
        }
        app_->subscribe(svc, inst, group, major);
        out(tag + " subscribed");
    }

private:
    void onMessage(const std::shared_ptr<vsomeip::message> &m) {
        std::shared_ptr<vsomeip::payload> p = m->get_payload();
        std::string data = p ? hex(p->get_data(), p->get_length()) : "";
        vsomeip::message_type_e t = m->get_message_type();
        if (t == vsomeip::message_type_e::MT_NOTIFICATION) {
            std::string line = std::string("ev ") + h4(m->get_service());
            line += std::string(" ") + h4(m->get_method()) + " " + data;
            out(line);
            return;
        }
        if (t != vsomeip::message_type_e::MT_RESPONSE && t != vsomeip::message_type_e::MT_ERROR) return;
        std::string tag;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = pending_.find(std::make_tuple(m->get_service(), m->get_method(), m->get_session()));
            if (it == pending_.end()) return;
            tag = it->second.tag;
            pending_.erase(it);
        }
        if (t == vsomeip::message_type_e::MT_ERROR || m->get_return_code() != vsomeip::return_code_e::E_OK) {
            out(tag + " error " + std::to_string(int(m->get_return_code())) + " " + data);
        } else {
            out(tag + " ok " + data);
        }
    }

    void expire() {
        while (!stopping_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::vector<std::string> late;
            {
                std::lock_guard<std::mutex> g(mu_);
                auto now = std::chrono::steady_clock::now();
                for (auto it = pending_.begin(); it != pending_.end();) {
                    if (it->second.deadline <= now) {
                        late.push_back(it->second.tag);
                        it = pending_.erase(it);
                    } else {
                        ++it;
                    }
                }
            }
            for (auto &t : late) out(t + " noreply");
        }
    }

    std::shared_ptr<vsomeip::runtime> rt_;
    std::shared_ptr<vsomeip::application> app_;
    std::thread worker_, timer_;
    std::mutex mu_;
    std::condition_variable cv_;
    bool registered_ = false;
    volatile bool stopping_ = false;
    std::set<std::pair<vsomeip::service_t, vsomeip::instance_t>> requested_;
    std::map<std::pair<vsomeip::service_t, vsomeip::instance_t>, bool> available_;
    std::map<std::tuple<vsomeip::service_t, vsomeip::method_t, vsomeip::session_t>, Pending> pending_;
};

Client client;

/* one command (words after the tag); false with why on bad input */
bool run(const std::string &tag, const std::vector<std::string> &w, std::string &why, bool async) {
    if (w.empty()) { why = "empty"; return false; }
    const std::string &c = w[0];
    unsigned long svc, inst, a, major;
    if ((c == "call" || c == "send") && w.size() >= 5) {
        if (!num(w[1], 0xffff, svc) || !num(w[2], 0xffff, inst) || !num(w[3], 0xffff, a) || !num(w[4], 0xff, major)) {
            why = "numbers"; return false;
        }
        size_t i = 5;
        bool reliable = true;
        if (w.size() > i && (w[i] == "tcp" || w[i] == "udp")) reliable = (w[i++] == "tcp");
        std::vector<vsomeip::byte_t> body;
        if (w.size() > i && !unhex(w[i], body)) { why = "hex"; return false; }
        auto job = [=] { client.call(tag, svc, inst, a, major, reliable, body, c == "call"); };
        if (async) std::thread(job).detach(); else job();
        return true;
    }
    if (c == "sub" && w.size() >= 6) {
        unsigned long group;
        if (!num(w[1], 0xffff, svc) || !num(w[2], 0xffff, inst) || !num(w[3], 0xff, major) || !num(w[4], 0xffff, group)) {
            why = "numbers"; return false;
        }
        std::vector<vsomeip::event_t> events;
        for (size_t i = 5; i < w.size(); i++) {
            std::stringstream ss(w[i]);
            std::string e;
            while (std::getline(ss, e, ',')) {
                unsigned long ev;
                if (!num(e, 0xffff, ev)) { why = "event"; return false; }
                events.push_back(vsomeip::event_t(ev));
            }
        }
        auto job = [=] { client.sub(tag, svc, inst, major, group, events); };
        if (async) std::thread(job).detach(); else job();
        return true;
    }
    if (c == "avail" && w.size() >= 4) {
        if (!num(w[1], 0xffff, svc) || !num(w[2], 0xffff, inst) || !num(w[3], 0xff, major)) { why = "numbers"; return false; }
        auto job = [=] { out(tag + " avail " + (client.waitAvailable(svc, inst, major) ? "1" : "0")); };
        if (async) std::thread(job).detach(); else job();
        return true;
    }
    why = "unknown command";
    return false;
}

std::vector<std::string> words(const std::string &line) {
    std::vector<std::string> w;
    std::istringstream is(line);
    std::string s;
    while (is >> s) w.push_back(s);
    return w;
}

volatile sig_atomic_t quit = 0;
void onSignal(int) { quit = 1; }

int usage(const char *me) {
    fprintf(stderr,
            "usage: %s call|send SVC INST METHOD MAJOR [tcp|udp] [HEX]\n"
            "       %s sub SVC INST MAJOR GROUP EVENT[,EVENT...]\n"
            "       %s serve\n", me, me, me);
    return 2;
}

}  // namespace

int main(int argc, char **argv) {
    if (argc < 2) return usage(argv[0]);
    std::vector<std::string> w(argv + 1, argv + argc);
    const std::string mode = w[0];
    if (mode != "call" && mode != "send" && mode != "sub" && mode != "avail" && mode != "serve") return usage(argv[0]);
    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);
    signal(SIGPIPE, SIG_IGN);
    if (!client.start()) {
        out("error vsomeip: not registered");
        client.stop();
        return 1;
    }
    out("state registered");
    int rc = 0;
    if (mode == "serve") {
        std::string line;
        while (!quit && std::getline(std::cin, line)) {
            std::vector<std::string> lw = words(line);
            if (lw.size() < 2) continue;
            std::string tag = lw[0], why;
            lw.erase(lw.begin());
            if (!run(tag, lw, why, true)) out(tag + " bad " + why);
        }
    } else {
        std::string why;
        if (!run("-", w, why, false)) {
            out("- bad " + why);
            rc = 2;
        } else if (mode == "call") {
            // the reply (or noreply) comes from another thread
            for (int i = 0; i < (kWaitMs + 500) / 20 && !answered && !quit; i++)
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
        } else if (mode == "sub") {
            while (!quit) std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }
    client.stop();
    return rc;
}
