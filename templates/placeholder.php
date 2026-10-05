<?php
declare(strict_types=1);
/**
 * Shown while the frontend (templates/main.php and js/calcbase.dist.js) is not
 * in place: the app is installed and its API answers, but there is no screen yet.
 */
?>
<div id="calcbase" class="app-calcbase">
	<div id="calcbase-root" data-version="<?php p($_['version'] ?? ''); ?>" data-theme="<?php p($_['theme'] ?? 'auto'); ?>" data-fileid="<?php p((string)($_['fileId'] ?? 0)); ?>">
		<div style="max-width:40em;margin:15vh auto;padding:24px;text-align:center;font-size:15px">
			<p style="font-size:28px;font-weight:700;margin:0 0 8px"><span style="color:#e56b00">C</span><span style="color:#0000ff">B</span> CalcBase <?php p($_['version'] ?? ''); ?></p>
			<p><?php p($_['notReady'] ?? 'CalcBase is installed, but its screen is not built yet.'); ?></p>
		</div>
	</div>
</div>
