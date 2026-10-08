"""Typed input and fill series as LibreOffice Calc 24.2 (ja-JP) reads them.
Uses the QA tools' Uno (/root/calcbase-tests/py/lo.py: one soffice, shared lock).
The answers are kept in lo-input.json beside this file; run.mjs checks the engine against them.
Usage: python3 lo_input.py lo-input.json"""
import json
import sys
sys.path.insert(0, '/root/calcbase-tests/py')
from lo import Uno  # noqa: E402

TYPED = [
    '2026/10/5', '26/10/5', '2026/10/05', '2026-10-5', '2026-1-2', '1-2-3', '2026.10.5', '10-5', '10/5', '2026/10', '2026年10月',
    '10月5日', '2026年10月5日', '2026年1月2日', 'R8/10/5', 'H31/4/30', '2026/10/5 10:30', '2026/10/5 10:30:15', '2026-10-05 10:30',
    '2026-10-05T10:30', '10月5日 10:30', '2026/2/29', '1582/10/14', '1583/1/1', '99/1/2', '29/1/2', '30/1/2',
    '10:30', '10:30:15', '10:30:15.5', '10:30:15.123', '25:00', '1:60', '12:00 PM', '10:30 AM', '10:30AM', '午後1:30', '0:30', '100:00', '10:30:60',
    '1,234', '1,23', '１，２３４', '１２３４．５', '−5', '－5', '△5', '12%', '１２％', '12 %', '1e3', '1E+3', '1.5e-3', '(5)', '5-', '+5',
    ' 5 ', '.5', '5.', '0123', '1 1/2', '3/4', '2 3/4', '0 1/2', '-1 1/2', '1 3/16', '13/4', '1/32', '1 1/0', '1 3/2',
    '￥1,200', '￥-5', '-￥5', '￥1,200.5', '￥ 1,200', '¥1,200', '$5', '＄5', '€5', '1,200円', '(￥5)',
    'TRUE', 'true', 'ＴＲＵＥ', '1 000', '１２３', '１/２', '２０２６/１０/５', '１０：３０',
]

SEEDS = [
    ['Mon'], ['Monday'], ['Jan'], ['January'], ['月'], ['月曜日'], ['日'], ['1月'], ['12月'], ['Q1'], ['第1回'], ['1-A'], ['A-1'], ['1A'], ['A1'],
    ['No.1'], ['1番'], ['1st'], ['Item 1'], ['Item 01'], ['001'], ['abc1def'], ['1.5.2'], ['1 2'], ['x 1 y'], ['10:00'], ['2026/10/5'],
    ['2026/1/31', '2026/2/28'], ['2026/1/31'], ['2026/1/31', '2026/3/31'], ['2026/1/30', '2026/2/28'], ['2026/2/28', '2026/3/31'],
    ['1', '2', '4'], ['子'], ['睦月'], ['一月'], ['1回目'], ['Mon', 'Wed'], ['1月', '3月'], ['TRUE', 'FALSE'], ['a', 'b'], ['-1'], ['1-1'], ['x-1-1'],
    ['日曜日'], ['火', '木'], ['Item 1', 'Item 3'], ['第1回', '第2回'], ['A1', 'A3'], ['10:00', '11:00'], ['1.5'], ['abc', '1'], ['1', 'abc'],
    ['A-9'], ['Item 99'], ['Item -1'], ['-A'], ['1-'], ['a1b2'], ['Q4'], ['2026'], ['令和1年'],
]
FILL_TO = 8


def main(out):
    lo = Uno()
    res = {'typed': {}, 'fill': []}
    try:
        doc = lo.new_calc()
        sh = doc.Sheets.getByIndex(0)
        ctl = doc.getCurrentController()
        fmts = doc.getNumberFormats()
        for i, t in enumerate(TYPED):
            a = 'A%d' % (i + 1)
            ctl.select(sh.getCellRangeByName(a))
            lo.run(doc, '.uno:EnterString', [('StringName', t)])
            cell = sh.getCellRangeByName(a)
            key = cell.NumberFormat
            res['typed'][t] = {'shown': cell.getString(), 'value': cell.getValue(), 'type': cell.getType().value,
                               'format': fmts.getByKey(key).FormatString if key else 'General'}
        doc.close(True)
        doc = lo.new_calc()
        sh = doc.Sheets.getByIndex(0)
        ctl = doc.getCurrentController()
        fmts = doc.getNumberFormats()
        from com.sun.star.sheet.FillDirection import TO_BOTTOM
        for i, seed in enumerate(SEEDS):
            c = i + 1
            for r, text in enumerate(seed):
                ctl.select(sh.getCellByPosition(c, r))
                lo.run(doc, '.uno:EnterString', [('StringName', text)])
            rng = sh.getCellRangeByPosition(c, 0, c, FILL_TO - 1)
            rng.fillAuto(TO_BOTTOM, len(seed))
            cells = []
            for r in range(FILL_TO):
                cell = sh.getCellByPosition(c, r)
                key = cell.NumberFormat
                cells.append({'shown': cell.getString(), 'value': cell.getValue(), 'type': cell.getType().value,
                              'format': fmts.getByKey(key).FormatString if key else 'General'})
            res['fill'].append({'seed': seed, 'cells': cells})
        doc.close(True)
    finally:
        lo.close()
    json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
    print('%d typed, %d seeds' % (len(res['typed']), len(res['fill'])))


if __name__ == '__main__':
    main(sys.argv[1])
