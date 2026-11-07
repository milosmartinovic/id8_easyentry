// SPDX-License-Identifier: GPL-3.0-or-later
// Test double for seatctl: offers VehicleCondition-like service 0x1531/1 (event 0x8002, group 2) and a
// "seat" service 0xB5AA/1 with method 12 (memory recall) answering its payload back, and method 13 -> error.
#include <vsomeip/vsomeip.hpp>
#include <chrono>
#include <iostream>
#include <set>
#include <thread>
int main() {
    auto rt = vsomeip::runtime::get();
    auto app = rt->create_application("fake-provider");
    if (!app->init()) return 1;
    app->register_message_handler(0xB5AA, 1, vsomeip::ANY_METHOD, [&](const std::shared_ptr<vsomeip::message> &m) {
        auto r = rt->create_response(m);
        auto in = m->get_payload();
        std::cerr << "provider: method " << m->get_method() << " len " << in->get_length() << std::endl;
        if (m->get_method() == 13) r->set_return_code(vsomeip::return_code_e::E_NOT_OK);
        std::vector<vsomeip::byte_t> b(in->get_data(), in->get_data() + in->get_length());
        b.insert(b.begin(), 0xAC);
        auto p = rt->create_payload(); p->set_data(b); r->set_payload(p);
        app->send(r);
    });
    std::thread t([&] { app->start(); });
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    app->offer_service(0xB5AA, 1, 1, 0);
    app->offer_service(0x1531, 1, 1, 0);
    app->offer_event(0x1531, 1, 0x8002, std::set<vsomeip::eventgroup_t>{2}, vsomeip::event_type_e::ET_FIELD,
                     std::chrono::milliseconds::zero(), false, true, nullptr, vsomeip::reliability_type_e::RT_UNKNOWN);
    std::this_thread::sleep_for(std::chrono::seconds(3));   // the client subscribes meanwhile
    int conds[] = {5, 5, 8, 10, 10, 12, 5};
    for (int c : conds) {
        std::vector<vsomeip::byte_t> b = {0, 0, 0, 0, 0, vsomeip::byte_t(c), 0, 0};
        auto p = rt->create_payload(); p->set_data(b);
        app->notify(0x1531, 1, 0x8002, p);
        std::this_thread::sleep_for(std::chrono::milliseconds(700));
    }
    std::this_thread::sleep_for(std::chrono::seconds(4));
    app->stop(); t.join();
}
