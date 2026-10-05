<?php
/**
 * LibreOffice for the tests that need it: a file CalcBase wrote is opened by
 * soffice --headless with recalculation forced (its own profile, made here),
 * and each sheet is written out as CSV, as shown or as raw values.
 *
 * Skipped -- the test says so -- where soffice is not installed.
 */
declare(strict_types=1);

function sofficeAvailable(): bool {
	$path = trim((string)shell_exec('command -v soffice 2>/dev/null'));
	return $path !== '' && is_executable($path);
}

/** A LibreOffice profile that recalculates every formula on load, whoever wrote the file. */
function loProfile(): string {
	$dir = sys_get_temp_dir() . '/calcbase-lo-profile';
	if (!is_dir($dir . '/user')) {
		mkdir($dir . '/user', 0700, true);
	}
	file_put_contents($dir . '/user/registrymodifications.xcu', '<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
');
	return $dir;
}

/**
 * Every sheet of a spreadsheet file as CSV text: sheet name => rows of fields.
 *
 * @return array<string, list<list<string>>>
 */
function loSheets(string $file, bool $asShown): array {
	$out = sys_get_temp_dir() . '/calcbase-lo-out-' . getmypid();
	if (is_dir($out)) {
		foreach (glob($out . '/*') ?: [] as $f) {
			unlink($f);
		}
	} else {
		mkdir($out, 0700, true);
	}
	// Token 9: save cell contents as shown; token 12: -1 = every sheet, one file each.
	$filter = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,' . ($asShown ? 'true' : 'false') . ',false,false,-1';
	$cmd = 'timeout 180 soffice --headless -env:UserInstallation=file://' . loProfile()
		. ' --convert-to ' . escapeshellarg($filter) . ' --outdir ' . escapeshellarg($out) . ' ' . escapeshellarg($file) . ' 2>&1';
	shell_exec($cmd);
	$sheets = [];
	$stem = pathinfo($file, PATHINFO_FILENAME);
	foreach (glob($out . '/*.csv') ?: [] as $csv) {
		$name = pathinfo($csv, PATHINFO_FILENAME);
		if (str_starts_with($name, $stem . '-')) {
			$name = substr($name, strlen($stem) + 1);
		}
		$rows = [];
		foreach (OCA\CalcBase\Service\CsvFormat::rows((string)file_get_contents($csv), ',') as $row) {
			$rows[] = $row;
		}
		$sheets[$name] = $rows;
		unlink($csv);
	}
	return $sheets;
}
