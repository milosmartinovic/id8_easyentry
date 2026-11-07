#!/usr/bin/env node
'use strict';
/*
 * gen_rhmi.js - writes the Easy entry app's RHMI description for iDrive 8 (package/rhmiData/uiDescriptions/ID8)
 * and its English texts, with the HMI's own list widgets (LT_State_Wide_List, LT_Button_MediaEntry_1Row rows with
 * a value on the right, LT_ScrollLabel labels). The widget choice and the file layout follow the Store's
 * tools/gen_rhmi.js (robertnisipeanu/mgu-store, GPL-3.0-or-later). On iDrive 8 no state names a parent.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package');
const ID8 = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID8');
const TEXTS = path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts');

const row = (id, name, text) => ({ id, kind: 'row', name, text, focusable: 3 });
const button = (id, name, text) => ({ id, kind: 'button', name, text, focusable: 3 });
const label = (id, name, text) => ({ id, kind: 'label', name, text: text || '', focusable: 0 });

const LANGUAGES = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'es_MX', 'fi_FI', 'fr_CA', 'fr_FR',
    'he_IL', 'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nl_BE', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT', 'ro_RO', 'ru_RU',
    'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW', 'zh_yue_Hans_CN', 'zh_yue_Hant_CN'];

const sid = (words) => `SID_EE_${words.replace(/\?/g, ' Q').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const words = (text) => (text ? { value: sid(text), type: 'StringId' } : { value: '', type: 'Text' });
const media = (primary, freq) => ({ PrimaryText: primary, FrequencyText: freq || '', FrequencyVisible: freq !== null,
    IconVisible: false, ProgressVisible: false, IsPlaying: false });
const WIDGET = {
    button: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, null) }),
    row: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, '') }),
    label: (c) => ({ type: 'label', widget: 'LT_ScrollLabel', cells: { Text: c.text } }),
};

const STATES = [
    { id: 1, name: 'ST_OnlineApps_EasyEntry', titleId: 10, title: 'Easy entry', components: [
        label(20, 'eeStatus', 'Easy entry'),
        row(21, 'eeEnabled', 'Easy entry / exit'),
        row(22, 'eeExitMode', 'Exit position'),
        row(23, 'eeBack', 'Back travel'),
        row(24, 'eeUp', 'Raise seat'),
        row(25, 'eeTrigger', 'Move back when'),
        row(26, 'eeEntry', 'Memory 1 at engine start'),
        label(27, 'eePositionNote'),
        button(28, 'eeNavSetup', 'Seat and door setup'),
        button(29, 'eeNavTest', 'Test'),
        label(30, 'eeLast'),
        Object.assign(label(31, 'eeHmiID8'), { visible: 0 }),
    ] },
    { id: 2, name: 'ST_OnlineApps_EasyEntrySetup', titleId: 11, title: 'Seat and door setup', components: [
        label(40, 'eeSetupStatus'),
        row(41, 'eeSetMemory', 'Seat memory'),
        row(42, 'eeSetPosition', 'Seat position'),
        row(43, 'eeSetDoor', 'Driver door'),
        button(44, 'eeRescan', 'Search the catalog again'),
        button(45, 'eeExport', 'Save findings to USB'),
        label(46, 'eeSetupNote'),
    ] },
    { id: 3, name: 'ST_OnlineApps_EasyEntryPick', titleId: 12, title: 'Pick', components: [
        label(50, 'eePickWhat'),
        row(51, 'eePickList', ''),
        button(52, 'eePickNone', 'Not set'),
    ] },
    { id: 4, name: 'ST_OnlineApps_EasyEntryTest', titleId: 13, title: 'Test', components: [
        label(60, 'eeTestNote'),
        button(61, 'eeTestExit', 'Move for exit'),
        button(62, 'eeTestMem1', 'Memory 1'),
        button(63, 'eeTestMem2', 'Memory 2'),
        label(64, 'eeTestResult'),
    ] },
];

function xml() {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    STATES.forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="LT_State_Wide_List">`,
            `        <layoutGroup id="${100 + 2 * s.id}" name="Titlebar">`,
            `            <component id="${s.titleId}" type="title">`,
            '                <property id="2" value="1"/>',
            '            </component>',
            '        </layoutGroup>',
            `        <layoutGroup id="${101 + 2 * s.id}" name="List">`,
            '            <property id="3" value="1"/>');
        s.components.forEach((c) => {
            const w = WIDGET[c.kind](c);
            lines.push(`            <component id="${c.id}" type="${w.type}" widget="${w.widget}">`,
                `                <property id="2" value="${c.visible === 0 ? 0 : 1}"/>`,
                `                <property id="3" value="${c.focusable}"/>`,
                '            </component>');
        });
        lines.push('        </layoutGroup>', '    </container>');
    });
    lines.push('</application>', '');
    return lines.join('\n');
}

function uiDescription() {
    const containers = {};
    STATES.forEach((s) => {
        const components = { [s.titleId]: { type: 'title', name: `${s.name}_Title`,
            properties: { Visible: { value: 1, type: 'UInt' } }, rows: [{ Text: words(s.title) }] } };
        s.components.forEach((c) => {
            const w = WIDGET[c.kind](c), cells = {};
            Object.keys(w.cells).forEach((k) => {
                const v = w.cells[k];
                cells[k] = typeof v === 'boolean' ? { value: v, type: 'Bool' } : words(v);
            });
            components[c.id] = { type: w.type, name: c.name,
                properties: { Visible: { value: c.visible === 0 ? 0 : 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: [cells] };
        });
        containers[s.id] = { type: 'state', name: s.name, components };
    });
    return { schemaVersion: '1.3.0', containers };
}

function english() {
    const out = { SID_TEMP_EMPTY: '', SID_EE_TITLE: 'Easy entry' };
    STATES.forEach((s) => [s.title].concat(s.components.map((c) => c.text)).filter(Boolean).forEach((t) => { out[sid(t)] = t; }));
    return out;
}

function write() {
    fs.mkdirSync(ID8, { recursive: true });
    fs.mkdirSync(TEXTS, { recursive: true });
    fs.writeFileSync(path.join(ID8, 'application.xml'), xml());
    fs.writeFileSync(path.join(ID8, 'uiDescription.json'), `${JSON.stringify(uiDescription(), null, 2)}\n`);
    const en = `${JSON.stringify(english(), null, 2)}\n`;
    // English for every HMI language (the app's words are English only)
    LANGUAGES.forEach((n) => fs.writeFileSync(path.join(TEXTS, `${n}.json`), en));
}

if (require.main === module) {
    write();
    console.log(`wrote ${path.relative(process.cwd(), ID8)}: ${STATES.length} states, ` +
        `${STATES.reduce((n, s) => n + s.components.length, 0)} components`);
}

module.exports = { STATES, sid, write };
