"""Brand bundled guidance and new compute names; retain stored resource identities."""
from pathlib import PurePosixPath,Path
import re

SOURCE=Path(__file__).resolve().parents[1]/'src'

def brand_skill_resource(name:str,data:bytes)->bytes:
    path=PurePosixPath(name.removeprefix('./'))
    if path.parts[:1] not in [('skills',),('agents',)] or 'LICENSE' in path.name.upper():return data
    if str(path)=='skills/product-self-knowledge/SKILL.md':return (SOURCE/'product-self-knowledge.md').read_bytes()
    if path.suffix not in {'.md','.yaml','.yml','.py'}:return data
    text=data.decode('utf8')
    if path.suffix in {'.md','.yaml','.yml'}:
        text=text.replace('(by Anthropic Labs)','')
        text=text.replace('Claude Code or Claude.ai user','Chimeric user')
        text=re.sub(r'\bClaude Science\b|\bClaude-Science\b','Chimeric',text)
        text=text.replace('Claude Code','Chimeric').replace('Claude.ai','Chimeric').replace('Claude API','configured model API')
        text=re.sub(r'\bClaude\b','the assistant',text)
        text=text.replace('"anthropic" (bundled','"<bundled-origin>" (bundled').replace('anthropic bundled','bundled')
        text=text.replace('`anthropic_api_keys`, ','provider key stores, ')
        text=text.replace('claude-science-default','chimeric-default').replace('claude-science-job','chimeric-job')
        text=text.replace('bare host creates `~/.claude-science-scratch` as the fallback','bare host creates a private fallback scratch directory')
        text=re.sub(r'claude-science-([a-z0-9-]+(?:weights|cache))',r'<existing-\1-volume>',text)
        text=text.replace('Settings → Credentials','Settings → Connections')
        if str(path)=='skills/customize/SKILL.md':
            old=('Publishing shares the skill with the user\'s\norganization through claude.ai. If `host.skills.publish` fails because this\napp has no working claude.ai sign-in (some setups, such as a managed VM, have\nnone), do not retry it: tell the user the skill is saved and ready to use\nin their chats here, and that sharing it with their organization needs a\nclaude.ai sign-in.')
            new=('Organization publication depends on the running SDK and configured sharing\nservice. If `host.skills.publish` reports that publication is unavailable, keep\nthe local draft and explain that it is usable in this workspace. Share an\nexported skill directory when requested; do not ask for a separate vendor login.')
            if text.count(old)!=1:raise ValueError('Bundled skill publication guidance changed')
            text=text.replace(old,new)
        if str(path)=='skills/skill-creator/SKILL.md':
            text=text.replace('claude-with-access-to-the-skill','the configured model with access to the skill')
            start=text.index('### Step 3: Run the optimization loop')
            end=text.index('### How skill triggering works',start)
            text=text[:start]+'''### Step 3: Evaluate with the configured model

Use the current Chimeric model and available research tools to evaluate the
approved queries in independent test sessions. Inspect the current SDK schema
before using delegation or session tools. Record whether each query loaded the
skill and whether its result met the requested outcome. Keep development and
held-out queries separate, and disclose any exposure to the held-out results.

Compare descriptions using the same queries and model settings. Record the
selected description as `best_description` with the observed outcomes. Inspect
optional helper dependencies before running them; use a helper only when its
required runtime is configured. Report unavailable automation plainly, and do
not claim trigger scores from a manual review.

'''+text[end:]
            start=text.index('## Chimeric-specific instructions')
            end=text.index('## Reference files',start)
            text=text[:start]+'''## Tool availability and evaluation

Inspect the tools available in the current Chimeric session. Use delegation for
independent evaluation when supported. When it is unavailable, gather qualitative
feedback and label the result accordingly. Avoid claiming a blind comparison or
quantitative benchmark without independent runs.

Use the bundled review viewer when it is available. If an interactive viewer
cannot run in the current environment, generate a static HTML artifact with
`generate_review.py` and let the user review its outputs. Read exported feedback
through the workspace's normal file tools.

Apply the existing-skill update guidance when revising an installed skill.
Inspect optional helper dependencies before running them. Keep the configured
model connection and normal workspace permissions throughout evaluation.

'''+text[end:]
        text=re.sub(r'\bAnthropic(?:\s+Labs)?\b','the model provider',text)
    elif str(path)=='skills/remote-compute-modal/provider.py':
        # Existing owner tags and cache/volume names remain compatible. A new
        # default app is searched alongside its predecessor by the reaper.
        old='FALLBACK_APP_NAME = "claude-science-default"'
        if text.count(old)!=1:raise ValueError('Modal fallback app boundary changed')
        text=text.replace(old,'FALLBACK_APP_NAME = "chimeric-default"')
        text=text.replace('for extra_name in (FALLBACK_APP_NAME, LEGACY_APP_NAME,','for extra_name in (FALLBACK_APP_NAME, "claude-science-default", LEGACY_APP_NAME,')
        text=text.replace('prior_name in (self._app_name, FALLBACK_APP_NAME,','prior_name in (self._app_name, FALLBACK_APP_NAME, "claude-science-default",')
        text=text.replace('Claude Science','Chimeric')
    elif str(path)=='skills/literature-review/kernel.py':
        text=text.replace('Claude-Science (+https://claude.com/product/claude-science)','Chimeric (local research workbench)')
    return text.encode('utf8')

if __name__=='__main__':
    import hashlib,json,sys,tarfile
    with tarfile.open(sys.argv[1],'r:gz') as archive:
        name='./skills/remote-compute-modal/provider.py'
        before=archive.extractfile(name).read()
        after=brand_skill_resource(name,before)
        print(json.dumps({'path':name,'beforeSha256':hashlib.sha256(before).hexdigest(),'afterSha256':hashlib.sha256(after).hexdigest()}))
