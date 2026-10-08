<?php
/**
 * Tables read out of HTML and Markdown into sheets (HtmlTables, MarkdownTables,
 * TextValues) -- what the EditBase, web and Markdown imports are made of.
 *
 *   - an EditBase table: the formula on the cell (data-eb-formula) is kept as the
 *     cell's f, its shown number read as the value, eb-al-r as right alignment,
 *     <th> as bold, an empty <td><br></td> as no cell;
 *   - a CalcBase book saved as a page (data-f, data-v, data-t, data-fmt) comes back
 *     with its formulas, raw values, types and formats;
 *   - colspan/rowspan become merges and the covered cells are not cells;
 *   - the caption or the heading above names the sheet; a nested table is a sheet
 *     of its own; a cell's script is not its text; a link stays on the cell;
 *   - text is read for what it means: numbers with thousands, yen, percent, dates
 *     in three writings, times, TRUE/FALSE, errors -- and a phone number stays text;
 *   - Markdown pipe tables: header bold, alignment from the separator, marks taken
 *     off, links kept, escaped pipes, the heading above as the name;
 *   - the sample document shipped with EditBase, when it is there.
 *
 * Run: php tests/html_tables_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\HtmlTables;
use OCA\CalcBase\Service\MarkdownTables;
use OCA\CalcBase\Service\Model;
use OCA\CalcBase\Service\TextValues;

echo "--- an EditBase table ---\n";
$eb = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Office supplies</title></head><body>'
	. '<h2>Purchases in October</h2>'
	. '<table class="eb-table" data-eb-id="bwysqiag"><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>'
	. '<tr><td>Copy paper, A4 (500 sheets)</td><td class="eb-al-r">4</td><td class="eb-al-r">650</td><td class="eb-al-r" data-eb-formula="=B2*C2">2600</td></tr>'
	. '<tr><td>Toner <b>cartridge</b></td><td class="eb-al-r">2</td><td class="eb-al-r">8,800</td><td class="eb-al-r" data-eb-formula="=B3*C3">17600</td></tr>'
	. '<tr><td>Total</td><td><br></td><td><br></td><td class="eb-al-r" data-eb-formula="=SUM(D2:D3)" data-eb-numfmt="#,##0">20,200</td></tr>'
	. '</tbody></table></body></html>';
$sheets = attempt('read', static fn () => HtmlTables::fromHtml($eb)) ?? [];
check('one table, one sheet', count($sheets) === 1, (string)count($sheets));
$s = $sheets[0] ?? ['cells' => [], 'name' => ''];
check('the heading above names the sheet', $s['name'] === 'Purchases in October', $s['name']);
check('a header cell is bold text', ($s['cells']['A1'] ?? null) === ['v' => 'Item', 't' => 's', 's' => ['b' => 1]], json_encode($s['cells']['A1'] ?? null));
check('a number shown is a number', ($s['cells']['B2'] ?? null) === ['v' => 4, 't' => 'n', 's' => ['ha' => 'right']], json_encode($s['cells']['B2'] ?? null));
check('a formula is kept as the formula, its shown number as the value', ($s['cells']['D2']['f'] ?? '') === '=B2*C2' && ($s['cells']['D2']['v'] ?? null) === 2600 && ($s['cells']['D2']['t'] ?? '') === 'n', json_encode($s['cells']['D2'] ?? null));
check('a number with thousands keeps its format', ($s['cells']['C3']['v'] ?? null) === 8800 && ($s['cells']['C3']['fmt'] ?? '') === '#,##0', json_encode($s['cells']['C3'] ?? null));
check('an EditBase number format is kept', ($s['cells']['D4']['fmt'] ?? '') === '#,##0' && ($s['cells']['D4']['v'] ?? null) === 20200 && ($s['cells']['D4']['f'] ?? '') === '=SUM(D2:D3)', json_encode($s['cells']['D4'] ?? null));
check('an empty <td><br></td> is no cell', !isset($s['cells']['B4']) && !isset($s['cells']['C4']));
check('a bold run inside a text cell is its text', ($s['cells']['A3']['v'] ?? '') === 'Toner cartridge', json_encode($s['cells']['A3'] ?? null));
check('columns get widths from the longest text', ($s['cols']['A'] ?? 0) > 100, json_encode($s['cols']));
$model = attempt('clean', static fn () => Model::clean(['sheets' => $sheets, 'active' => 0]));
check('the sheet passes the model\'s own check', $model !== null && isset($model['sheets'][0]['cells']['D2']['f']));

echo "--- a CalcBase book saved as a page ---\n";
$cb = '<section class="cb-sheet" data-name="Sheet1"><table><colgroup><col style="width:96px"><col style="width:64px"></colgroup><tbody>'
	. '<tr><td data-t="s">Item</td><td data-f="=SUM(B2:B5)" data-t="n" data-v="1234.5" data-fmt="#,##0.00" style="font-weight:700;text-align:right;background-color:#fff2cc">1,234.50</td></tr>'
	. '<tr><td data-t="s">0123</td><td data-t="b" data-v="TRUE">TRUE</td></tr>'
	. '<tr><td data-t="e">#DIV/0!</td><td data-t="n" data-v="46300" data-fmt="yyyy/mm/dd">2026/10/05</td></tr>'
	. '</tbody></table></section>';
$s = (attempt('read', static fn () => HtmlTables::fromHtml($cb)) ?? [])[0] ?? ['cells' => []];
check('formula, raw value, format and style come back', ($s['cells']['B1'] ?? null) === ['v' => 1234.5, 't' => 'n', 'f' => '=SUM(B2:B5)', 'fmt' => '#,##0.00', 'd' => '1,234.50', 's' => ['b' => 1, 'bg' => '#fff2cc', 'ha' => 'right']], json_encode($s['cells']['B1'] ?? null));
check('a text that looks like a number stays text when marked so', ($s['cells']['A2'] ?? null) === ['v' => '0123', 't' => 's'], json_encode($s['cells']['A2'] ?? null));
check('a boolean', ($s['cells']['B2'] ?? null) === ['v' => true, 't' => 'b'], json_encode($s['cells']['B2'] ?? null));
check('an error', ($s['cells']['A3'] ?? null) === ['v' => '#DIV/0!', 't' => 'e'], json_encode($s['cells']['A3'] ?? null));
check('a date serial with its format and shown text', ($s['cells']['B3'] ?? null) === ['v' => 46300, 't' => 'n', 'fmt' => 'yyyy/mm/dd', 'd' => '2026/10/05'], json_encode($s['cells']['B3'] ?? null));
check('column widths from the colgroup', ($s['cols'] ?? null) === ['A' => 96, 'B' => 64], json_encode($s['cols'] ?? null));
check('the section\'s name names the sheet', ($s['name'] ?? '') === 'Table 1', $s['name'] ?? '');

echo "--- merges, captions, nesting, scripts, links ---\n";
$web = '<html><body><p>Intro</p><table><caption>Prices</caption>'
	. '<tr><th colspan="2">Fruit</th><th rowspan="2">Note</th></tr>'
	. '<tr><td>Apple</td><td>¥120</td></tr>'
	. '<tr><td><a href="https://example.com/pear">Pear</a></td><td>12.5%</td><td><script>alert(1)</script>cheap<br>today</td></tr>'
	. '<tr><td>Grape</td><td>2026-10-05</td><td><table><tr><td>inner</td><td>9</td></tr></table></td></tr>'
	. '</table><h3>Second</h3><table><tr><td>a</td></tr></table></body></html>';
$sheets = attempt('read', static fn () => HtmlTables::fromHtml($web)) ?? [];
check('the outer table, the nested one and the second table are three sheets', count($sheets) === 3, (string)count($sheets));
$s = $sheets[0] ?? ['cells' => [], 'merges' => [], 'name' => ''];
check('the caption names the sheet', $s['name'] === 'Prices', $s['name']);
check('colspan and rowspan become merges', $s['merges'] === ['A1:B1', 'C1:C2'], json_encode($s['merges']));
check('the covered cells are not cells', !isset($s['cells']['B1']) && !isset($s['cells']['C2']));
check('the cell after a rowspan lands in the right column', ($s['cells']['A2']['v'] ?? '') === 'Apple' && ($s['cells']['B2']['v'] ?? null) === 120 && ($s['cells']['B2']['fmt'] ?? '') === '¥#,##0', json_encode([$s['cells']['A2'] ?? null, $s['cells']['B2'] ?? null]));
check('a link stays on the cell', ($s['cells']['A3']['link'] ?? '') === 'https://example.com/pear' && ($s['cells']['A3']['v'] ?? '') === 'Pear', json_encode($s['cells']['A3'] ?? null));
check('a percent', ($s['cells']['B3'] ?? null) === ['v' => 0.125, 't' => 'n', 'fmt' => '0.00%', 'd' => '12.5%'], json_encode($s['cells']['B3'] ?? null));
check('a script is not the cell\'s text; a <br> is a line', ($s['cells']['C3']['v'] ?? '') === "cheap\ntoday", json_encode($s['cells']['C3'] ?? null));
check('an ISO date', ($s['cells']['B4']['fmt'] ?? '') === 'yyyy-mm-dd' && ($s['cells']['B4']['v'] ?? null) === 46300, json_encode($s['cells']['B4'] ?? null));
check('a nested table\'s text is the outer cell\'s text', ($s['cells']['C4']['v'] ?? '') === "inner\n9", json_encode($s['cells']['C4'] ?? null));
check('the nested table is a sheet named after its number', ($sheets[1]['name'] ?? '') === 'Table 2' && ($sheets[1]['cells']['B1']['v'] ?? null) === 9, json_encode($sheets[1] ?? null));
check('a heading just above names the next one', ($sheets[2]['name'] ?? '') === 'Second', $sheets[2]['name'] ?? '');
check('the page title is read', HtmlTables::title($eb) === 'Office supplies');
check('no tables, no sheets', HtmlTables::fromHtml('<p>nothing</p>') === [] && HtmlTables::fromHtml('') === []);
$many = str_repeat('<table><tr><td>x</td></tr></table>', 60);
check('no more than 50 tables are taken', count(HtmlTables::fromHtml($many)) === 50);
$sheets = HtmlTables::fromHtml('<table><tr><td>日本語の見出し</td><td>１２３</td></tr></table>');
check('Japanese text is read as it is', ($sheets[0]['cells']['A1']['v'] ?? '') === '日本語の見出し' && ($sheets[0]['cells']['B1']['v'] ?? '') === '１２３', json_encode($sheets[0]['cells'] ?? null));

echo "--- what text means ---\n";
$cases = [
	['1,234.50', ['v' => 1234.5, 't' => 'n', 'fmt' => '#,##0.00']],
	['-12', ['v' => -12, 't' => 'n']],
	['3.5e2', ['v' => 350.0, 't' => 'n']],
	['¥1,200', ['v' => 1200, 't' => 'n', 'fmt' => '¥#,##0']],
	['$12.50', ['v' => 12.5, 't' => 'n', 'fmt' => '$#,##0.00']],
	['12%', ['v' => 0.12, 't' => 'n', 'fmt' => '0%']],
	['2026/10/5', ['v' => 46300, 't' => 'n', 'fmt' => 'yyyy/mm/dd']],
	['2026年10月5日', ['v' => 46300, 't' => 'n', 'fmt' => 'yyyy年m月d日']],
	['2026-10-05 10:30', ['v' => 46300.4375, 't' => 'n', 'fmt' => 'yyyy/mm/dd h:mm']],
	['10:30', ['v' => 0.4375, 't' => 'n', 'fmt' => 'h:mm']],
	['true', ['v' => true, 't' => 'b']],
	['#N/A', ['v' => '#N/A', 't' => 'e']],
	['Err:522', ['v' => 'Err:522', 't' => 'e']],
	['0982-00-0000', ['v' => '0982-00-0000', 't' => 's']],
	['2026/13/40', ['v' => '2026/13/40', 't' => 's']],
	['=SUM(A1)', ['v' => '=SUM(A1)', 't' => 's']],
	['  spaced   words ', ['v' => 'spaced   words', 't' => 's']],
	['', ['v' => '', 't' => 's']],
];
foreach ($cases as [$text, $want]) {
	$got = TextValues::cell($text);
	check('"' . $text . '"', $got == $want, json_encode($got));
}
check('a Unix time is a date-time serial', TextValues::unix(1791170400)['fmt'] === 'yyyy/mm/dd h:mm' && abs(TextValues::unix(0)['v'] - 25569) < 1e-9);
check('an ISO date-time from another app', TextValues::date('2026-10-05T10:30:00+09:00', true) == ['v' => 46300.4375, 't' => 'n', 'fmt' => 'yyyy/mm/dd h:mm'], json_encode(TextValues::date('2026-10-05T10:30:00+09:00', true)));
check('an ISO date alone', TextValues::date('2026-10-05') == ['v' => 46300, 't' => 'n', 'fmt' => 'yyyy/mm/dd']);

echo "--- Markdown pipe tables ---\n";
$md = "# Shopping\n\nSome words.\n\n| Item | Qty | Price | Link |\n|:-----|----:|------:|------|\n| **Apples** | 3 | 1,200 | [shop](https://example.com/a) |\n| Pears \\| ripe | 5 | 80 | plain |\n\nText between.\n\n## Second\n\n| a | b |\n| --- | --- |\n| `x` | *y* |\n";
$sheets = attempt('read', static fn () => MarkdownTables::fromText($md)) ?? [];
check('two tables, two sheets named after their headings', count($sheets) === 2 && $sheets[0]['name'] === 'Shopping' && $sheets[1]['name'] === 'Second', json_encode(array_column($sheets, 'name')));
$s = $sheets[0] ?? ['cells' => []];
check('the header is bold (and aligned as its column)', ($s['cells']['A1'] ?? null) === ['v' => 'Item', 't' => 's', 's' => ['b' => 1, 'ha' => 'left']], json_encode($s['cells']['A1'] ?? null));
check('the alignment comes from the separator', ($s['cells']['B2']['s']['ha'] ?? '') === 'right' && ($s['cells']['A2']['s']['ha'] ?? '') === 'left', json_encode($s['cells']['B2'] ?? null));
check('**bold** is bold without its marks', ($s['cells']['A2']['v'] ?? '') === 'Apples' && ($s['cells']['A2']['s']['b'] ?? 0) === 1, json_encode($s['cells']['A2'] ?? null));
check('a number with thousands', ($s['cells']['C2']['v'] ?? null) === 1200 && ($s['cells']['C2']['fmt'] ?? '') === '#,##0', json_encode($s['cells']['C2'] ?? null));
check('a link is its text with the link kept', ($s['cells']['D2']['v'] ?? '') === 'shop' && ($s['cells']['D2']['link'] ?? '') === 'https://example.com/a', json_encode($s['cells']['D2'] ?? null));
check('an escaped pipe is a pipe', ($s['cells']['A3']['v'] ?? '') === 'Pears | ripe', json_encode($s['cells']['A3'] ?? null));
check('code and italic marks are taken off', ($sheets[1]['cells']['A2']['v'] ?? '') === 'x' && ($sheets[1]['cells']['B2']['v'] ?? '') === 'y', json_encode($sheets[1]['cells'] ?? null));
check('no table in plain text', MarkdownTables::fromText("just | a | line\nwithout a separator") === []);

echo "--- the sample document shipped with EditBase ---\n";
$sample = '/root/dev/editbase/samples/Information.html';
if (is_readable($sample)) {
	$sheets = attempt('read', static fn () => HtmlTables::fromHtml((string)file_get_contents($sample))) ?? [];
	$found = null;
	foreach ($sheets as $sheet) {
		foreach ($sheet['cells'] as $cell) {
			if (($cell['f'] ?? '') === '=SUM(D2:D4)') {
				$found = $sheet;
			}
		}
	}
	check('its calculating table is read with its formulas', $found !== null && ($found['cells']['D2']['f'] ?? '') === '=B2*C2' && ($found['cells']['D2']['v'] ?? null) === 2600, json_encode($found['cells'] ?? null));
} else {
	echo "SKIP  EditBase's sample is not there\n";
}

finish();
