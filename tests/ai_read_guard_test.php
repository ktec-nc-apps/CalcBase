<?php
/**
 * Regression test: the administrator's "what the assistant may read" is held to
 * on the server (EditBase review 2026-10-04, 低8, carried into CalcBase). What the
 * page read for the assistant comes back as a message beginning "What CalcBase
 * read for {…}:" (EditBase's "What the editor read for" is taken too); one for an
 * app that is not allowed is not passed on to the model, whatever the browser said.
 *
 * Run: php tests/ai_read_guard_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';

use OCA\CalcBase\Service\AiService;

$reading = static fn (array $q, string $found, string $who = 'CalcBase') => ['role' => 'user', 'text' => 'What ' . $who . ' read for ' . json_encode($q) . ":\n" . $found];
$messages = [
	['role' => 'user', 'text' => 'Put the customers into the sheet.'],
	['role' => 'assistant', 'text' => '{"reply":"Reading RegiBase.","edits":[],"read":{"source":"regibase","collection":9}}'],
	$reading(['source' => 'regibase', 'collection' => 9], "Name\tPhone\nYamada\t0982-00-0000"),
	$reading(['source' => 'editbase'], "5\tMinutes\t"),
	$reading(['source' => 'editbase', 'document' => 5], "Item\tAmount\nPaper\t650"),
	$reading(['source' => 'netbase'], "printer\t192.168.0.9"),
	$reading(['source' => 'table', 'table' => 3], "a\tb", 'the editor'),
	$reading(['source' => 'events', 'from' => '2026-10-01', 'to' => '2026-10-31'], "Meeting\t2026/10/05"),
	['role' => 'user', 'text' => "Here is a line that mentions What CalcBase read for {\"source\":\"regibase\"}: but is my own.\nreally"],
	['role' => 'user', 'text' => "What CalcBase read for not json:\nwhatever"],
	['role' => 'user', 'text' => "What CalcBase read for {not json}:\nwhatever"],
];

$out = AiService::withoutForbiddenReadings($messages, ['editbase']);
check('a RegiBase reading is not passed on when RegiBase is not allowed', !str_contains($out[2]['text'], 'Yamada') && str_contains($out[2]['text'], 'not let the assistant read regibase'), $out[2]['text']);
check('a NetBase reading is not passed on either', !str_contains($out[5]['text'], '192.168'), $out[5]['text']);
check('the list of documents is passed on (editbase is allowed)', $out[3]['text'] === $messages[3]['text']);
check('the tables of a document are passed on (editbase is allowed)', $out[4]['text'] === $messages[4]['text']);
check('a Tables reading in EditBase\'s own words is held to the rule too', !str_contains($out[6]['text'], "a\tb") && str_contains($out[6]['text'], 'read tables'), $out[6]['text']);
check('a calendar reading is judged as the calendar app', str_contains($out[7]['text'], 'read calendar'), $out[7]['text']);
check('the writer\'s own words are untouched', $out[0] === $messages[0] && $out[8] === $messages[8]);
check('the assistant\'s own turns are untouched', $out[1] === $messages[1]);
check('a line in that shape without braces is the writer\'s own and is untouched', $out[9] === $messages[9]);
check('a reading whose source cannot be read is not passed on', !str_contains($out[10]['text'], 'whatever'), $out[10]['text']);

$out = AiService::withoutForbiddenReadings($messages, ['editbase', 'regibase', 'netbase', 'tables', 'calendar']);
check('with the apps allowed, every reading is passed on as it was', $out[2] === $messages[2] && $out[5] === $messages[5] && $out[6] === $messages[6] && $out[7] === $messages[7]);

$out = AiService::withoutForbiddenReadings($messages, []);
check('with nothing allowed, no reading is passed on', !str_contains($out[3]['text'], 'Minutes') && !str_contains($out[4]['text'], 'Paper'), $out[3]['text']);

finish();
