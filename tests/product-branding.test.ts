import {describe,expect,test} from 'bun:test';
import {brandFrontendUserText,brandNativeUserText} from '../tools/product-branding';

describe('native user-visible branding',()=>{
  test('rewrites displayed commands, prefixes, paths and vendor help links',()=>{
    expect(brandNativeUserText('claude-science: restart required')).toBe('chimeric: restart required');
    expect(brandNativeUserText('Run `claude-science sandbox doctor`; check ~/.claude-science/logs/.')).toBe('Run `chimeric sandbox doctor`; check <profile>/logs/.');
    expect(brandNativeUserText('https://claude.com/docs/claude-science/update-claude-science')).toBe('https://github.com/sammanalili/chimeric');
  });
  test('preserves compatibility identifiers and migration paths',()=>{
    expect(brandNativeUserText('claude-science')).toBe('claude-science');
    expect(brandNativeUserText('~/.claude-science')).toBe('~/.claude-science');
    expect(brandNativeUserText('source=anthropic model=Claude Opus 5.5')).toBe('source=anthropic model=Claude Opus 5.5');
  });
});

describe('frontend user-visible branding',()=>{
  test('rewrites the restart instruction and displayed config path',()=>{
    expect(brandFrontendUserText('Restart timed out — run `claude-science serve` manually.','./web-dist/assets/index-BgpYmw3d.js')).toBe('Restart timed out. Run `chimeric serve` manually.');
    expect(brandFrontendUserText('~/.claude-science/config.toml','./web-dist/assets/ControlPanelModal-OAuv-kWB.js')).toBe('profile/config.toml');
  });
  test('rewrites connector and scratch copy without touching migration commands elsewhere',()=>{
    const file='./web-dist/assets/CapabilitiesPage-D3j7I2By.js';
    expect(brandFrontendUserText('Jobs stage under ${root}/.claude-science/jobs/.',file)).toBe('Jobs stage under ${root}/Chimeric/jobs/.');
    expect(brandFrontendUserText("You're not signed in to claude.ai. Run `claude-science login` to refresh it.",file)).toBe("You're not signed in to the connector service. Refresh it in Settings → Connections.");
    expect(brandFrontendUserText('Import from ~/.claude-science with `claude-science import`.','./other.js')).toBe('Import from ~/.claude-science with `claude-science import`.');
  });
});
