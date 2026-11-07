<?php
/**
 * The assistant's writing into a book that is not open (AiTools, 2026-11-07): cells are
 * put into the book's HTML the way the page writes them -- every cell a <td>, a formula
 * as data-f (worked out when the book is opened), a number with data-t/data-v, a date as
 * its serial with a date format, text as text -- the table grows to the cell, merged
 * cells are left alone, a cell's format and style stay, and what is written reads back.
 *
 * Run: php tests/ai_tools_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\AiTools;
use OCA\CalcBase\Service\BookService;

$m = static function (string $name) {
	$r = new ReflectionMethod(AiTools::class, $name);
	$r->setAccessible(true);
	return static fn (...$a) => $r->invoke(null, ...$a);
};
$parse = $m('parse'); $apply = $m('apply'); $html = $m('html'); $sheets = $m('sheets'); $grid = $m('grid'); $tbody = $m('tbody'); $table = $m('table'); $text = $m('cellText');

$doc = $parse(BookService::blankBook('売上', '集計'));
[$done, $skipped] = $apply($doc, [
	['cell' => 'A1', 'input' => '品名'], ['cell' => 'B1', 'input' => '数量'],
	['cell' => 'A2', 'input' => 'りんご'], ['cell' => 'B2', 'input' => '3'],
	['cell' => 'A3', 'input' => 'みかん'], ['cell' => 'B3', 'input' => 4.5],
	['cell' => 'B4', 'input' => '=SUM(B2:B3)'], ['cell' => 'C2', 'input' => '2026/11/7'],
	['cell' => 'D1', 'input' => 'TRUE'], ['sheet' => 'ない', 'cell' => 'A1', 'input' => 'x'], ['cell' => 'Z', 'input' => 'x'],
]);
check('nine cells written, two refused with a reason', $done === 9 && count($skipped) === 2, json_encode($skipped, JSON_UNESCAPED_UNICODE));
$out = $html($doc);
check('still a book: doctype, one sheet named as given, UTF-8 text kept', str_starts_with($out, "<!DOCTYPE html>\n") && str_contains($out, 'data-name="集計"') && str_contains($out, 'りんご'), substr($out, 0, 300));
$doc2 = $parse($out);
$sh = $sheets($doc2)[0];
[$g, $rows, $width] = $grid($tbody($table($sh)));
check('the table grew to 4 rows of 4 cells, every cell a <td>', count($rows) === 4 && $width === 4 && count($g[3]) === 4);
$td = static fn ($r, $c) => $g[$r][$c]['td'];
check('a number: data-t n, data-v, shown', $td(1, 1)->getAttribute('data-t') === 'n' && $td(1, 1)->getAttribute('data-v') === '3' && $td(2, 1)->getAttribute('data-v') === '4.5');
check('a formula: data-f only, worked out on opening', $td(3, 1)->getAttribute('data-f') === '=SUM(B2:B3)' && $td(3, 1)->getAttribute('data-t') === '' && $text($td(3, 1)) === '=SUM(B2:B3) → ');
check('a date: its serial with a date format', $td(1, 2)->getAttribute('data-v') === '46333' && $td(1, 2)->getAttribute('data-fmt') === 'yyyy/mm/dd' && $td(1, 2)->textContent === '2026/11/07');
check('TRUE: a logical value', $td(0, 3)->getAttribute('data-t') === 'b' && $td(0, 3)->getAttribute('data-v') === 'TRUE');
check('text: data-t s', $td(0, 0)->getAttribute('data-t') === 's' && $td(0, 0)->textContent === '品名');
check('the columns got a width each', substr_count($out, '<col ') === 4);

// a merged cell, a styled cell and a formula kept around what is written
$book = "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>t</title></head><body class=\"cb-book\">"
	. '<section class="cb-sheet" data-name="S"><h2 class="cb-sheet-name">S</h2><table><colgroup><col style="width:90px"><col style="width:90px"></colgroup><tbody>'
	. '<tr><td colspan="2" data-t="s">見出し</td></tr><tr><td data-t="n" data-v="5" data-fmt="#,##0" style="font-weight:bold">5</td><td data-f="=A2*2" data-t="n" data-v="10">10</td></tr>'
	. '</tbody></table></section></body></html>';
$doc = $parse($book);
[$done, $skipped] = $apply($doc, [['cell' => 'B1', 'input' => 'x'], ['cell' => 'A2', 'input' => '1234'], ['cell' => 'C3', 'input' => "'0123"]]);
check('a cell inside a merge is refused', $done === 2 && count($skipped) === 1 && str_contains($skipped[0], 'merged'), json_encode($skipped, JSON_UNESCAPED_UNICODE));
$doc2 = $parse($html($doc));
[$g] = $grid($tbody($table($sheets($doc2)[0])));
check('the written cell keeps its format and style', $g[1][0]['td']->getAttribute('data-fmt') === '#,##0' && $g[1][0]['td']->getAttribute('style') === 'font-weight:bold' && $g[1][0]['td']->getAttribute('data-v') === '1234');
check('the formula next to it is left as it was', $g[1][1]['td']->getAttribute('data-f') === '=A2*2');
check('the merge is kept, and the table grew around it', $g[0][0]['td']->getAttribute('colspan') === '2' && isset($g[2][2]) && !$g[0][1]['td']->isSameNode($g[1][1]['td']));
check('a leading apostrophe makes text of digits', $g[2][2]['td']->getAttribute('data-t') === 's' && $g[2][2]['td']->textContent === '0123');
$cleared = $parse($html($doc));
$apply($cleared, [['cell' => 'A2', 'input' => '']]);
[$g] = $grid($tbody($table($sheets($cleared)[0])));
check('"" clears a cell (value gone, format kept)', $g[1][0]['td']->getAttribute('data-v') === '' && $g[1][0]['td']->textContent === '' && $g[1][0]['td']->getAttribute('data-fmt') === '#,##0');

finish();
