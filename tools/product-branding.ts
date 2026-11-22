const PUBLIC_SOURCE = 'https://github.com/sammanalili/chimeric';

/** Reword only app-owned text shown by the recovered native runtime. */
export function brandNativeUserText(value: string): string {
  if (value === 'https://claude.com/product/claude-science' ||
      value === 'https://claude.com/docs/claude-science/update-claude-science') return PUBLIC_SOURCE;
  let next = value
    .replaceAll('[claude-science sandbox]', '[chimeric sandbox]')
    .replace(/^claude-science:/, 'chimeric:')
    .replaceAll('`claude-science ', '`chimeric ')
    .replaceAll("'claude-science ", "'chimeric ")
    .replaceAll('Run claude-science ', 'Run chimeric ')
    .replaceAll('run claude-science ', 'run chimeric ');
  if (next.length > '~/.claude-science/logs/'.length) {
    next = next.replaceAll('~/.claude-science/logs/', '<profile>/logs/');
  }
  if (next.length > '~/.claude-science/config.toml'.length) {
    next = next.replaceAll('~/.claude-science/config.toml', '<profile>/config.toml');
  }
  return next;
}

/** Reword exact product copy in the native web interface. */
export function brandFrontendUserText(value: string, name: string): string {
  if (name.endsWith('/index-BgpYmw3d.js') && value === 'Restart timed out — run `claude-science serve` manually.') {
    return 'Restart timed out. Run `chimeric serve` manually.';
  }
  if (name.endsWith('/ControlPanelModal-OAuv-kWB.js') && value === '~/.claude-science/config.toml') {
    return 'profile/config.toml';
  }
  if (name.endsWith('/CapabilitiesPage-D3j7I2By.js')) {
    return value
      .replaceAll('/.claude-science/jobs/.', '/Chimeric/jobs/.')
      .replaceAll('~/.claude-science', 'the previous app’s data folder')
      .replaceAll('Run `claude-science login` to refresh it.', 'Refresh it in Settings → Connections.')
      .replaceAll('claude.ai', 'the connector service');
  }
  return value;
}
