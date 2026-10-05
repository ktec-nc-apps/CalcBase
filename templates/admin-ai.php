<?php
/** @var array $_ */
/** @var \OCP\IL10N $l */
$tb = $_['hub'];
$s = $_['settings'];
$off = !$tb['present'];
$providers = ['claude' => 'Claude', 'gemini' => 'Gemini', 'openai' => 'OpenAI'];
$reasons = [
	'no-key' => $l->t('No API key is set in AI-Hub.'),
	'no-cli' => $l->t('AI-Hub\'s command line tool is not set up.'),
	'no-store' => $l->t('AI-Hub needs a memory cache or a writable temporary folder.'),
	'no-model' => $l->t('No model is chosen in AI-Hub.'),
];
?>
<div id="calcbase-ai-admin" class="section<?php if ($off) { p(' cb-off'); } ?>"
	data-saved="<?php p($l->t('Saved.')); ?>" data-failed="<?php p($l->t('Could not save.')); ?>">
	<h2><?php p($l->t('AI assistant')); ?></h2>
	<p class="settings-hint"><?php p($l->t('CalcBase asks AI-Hub for its AI: a chat at the right of the sheet that knows spreadsheets and Calc formulas, and proposes changes to cells that are applied as one step the writer can undo. The key, the model and the limits are set in AI-Hub.')); ?></p>
	<?php if ($off) { ?>
		<p class="cb-ai-state warn"><?php p($l->t('AI-Hub is not installed or is switched off, so the assistant cannot be used. Install AI-Hub from the App Store to set it up here.')); ?></p>
	<?php } else { ?>
		<p class="cb-ai-state<?php if (!$tb['ready']) { p(' warn'); } ?>">
			<?php p($l->t('AI-Hub: %1$s (%2$s), model %3$s', [$providers[$tb['provider']] ?? $tb['provider'], $tb['mode'] === 'cli' ? $l->t('command line') : 'API', $tb['model'] !== '' ? $tb['model'] : '—'])); ?>
			— <?php p($tb['ready'] ? $l->t('Ready.') : ($reasons[$tb['reason']] ?? $tb['reason'])); ?>
		</p>
	<?php } ?>
	<fieldset <?php if ($off) { p('disabled'); } ?>>
		<p><input type="checkbox" class="checkbox" id="cb-ai-enabled" <?php if ($s['enabled']) { p('checked'); } ?>>
			<label for="cb-ai-enabled"><?php p($l->t('Use the AI assistant in CalcBase')); ?></label></p>

		<h3><?php p($l->t('Who may use it')); ?></h3>
		<p><input type="radio" class="radio" name="cb-ai-users" id="cb-ai-users-all" value="all" <?php if ($s['users'] === 'all') { p('checked'); } ?>>
			<label for="cb-ai-users-all"><?php p($l->t('Everyone')); ?></label></p>
		<p><input type="radio" class="radio" name="cb-ai-users" id="cb-ai-users-groups" value="groups" <?php if ($s['users'] === 'groups') { p('checked'); } ?>>
			<label for="cb-ai-users-groups"><?php p($l->t('Only the members of these groups')); ?></label></p>
		<div class="cb-ai-groups">
			<?php foreach ($_['groups'] as $g) { $gid = 'cb-ai-g-' . md5($g['id']); ?>
				<p><input type="checkbox" class="checkbox" id="<?php p($gid); ?>" data-group="<?php p($g['id']); ?>" <?php if (in_array($g['id'], $s['groups'], true)) { p('checked'); } ?>>
					<label for="<?php p($gid); ?>"><?php p($g['name']); ?></label></p>
			<?php } ?>
		</div>

		<h3><?php p($l->t('What it reads')); ?></h3>
		<p class="settings-hint"><?php p($l->t('Every question goes to the AI together with the open book: its name, the sheet names, the active sheet\'s used range as text with its formulas (the first 24,000 characters), and what is selected (up to 4,000 characters). Nothing else is read: no other books, no files, no other apps.')); ?></p>

		<h3><?php p($l->t('Web search')); ?></h3>
		<p><input type="checkbox" class="checkbox" id="cb-ai-search" <?php if ($s['search']) { p('checked'); } ?> <?php if (!$off && !$tb['search']) { p('disabled'); } ?>>
			<label for="cb-ai-search"><?php p($l->t('Let it search the web (on the AI provider\'s side: this server\'s own network is never reached)')); ?></label></p>
		<?php if (!$off && !$tb['search']) { ?>
			<p class="settings-hint"><?php p($l->t('Not available with the way AI-Hub connects to the AI.')); ?></p>
		<?php } ?>

		<p class="cb-ai-save"><button type="button" class="button primary" id="cb-ai-save"><?php p($l->t('Save')); ?></button>
			<span class="cb-ai-msg" aria-live="polite"></span></p>
	</fieldset>
</div>
