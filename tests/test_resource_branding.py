import ast
import importlib.util
from pathlib import Path
import tarfile
import typing
import unittest
import subprocess

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('resource_branding',ROOT/'tools/brand_skill_resources.py')
branding=importlib.util.module_from_spec(spec);spec.loader.exec_module(branding)
product_spec=importlib.util.spec_from_file_location('product_branding',ROOT/'tools/brand_product_resources.py')
product_branding=importlib.util.module_from_spec(product_spec);product_spec.loader.exec_module(product_branding)
ARCHIVE=ROOT.parents[1]/'work/runtime-recovery/original/assets.tar-j2zctwzf.gz'

@unittest.skipUnless(ARCHIVE.exists(),'verified original asset fixture unavailable')
class ResourceBrandingTests(unittest.TestCase):
 def original(self,name):
  with tarfile.open(ARCHIVE) as archive:return archive.extractfile('./'+name).read()
 def test_visible_guidance_and_resource_schemas(self):
  for name in ['skills/self-awareness/SKILL.md','skills/product-self-knowledge/SKILL.md','skills/skill-creator/SKILL.md','skills/customize/SKILL.md','skills/remote-compute-modal/SKILL.md','skills/compute-env-setup/SKILL.md','agents/onboarding/metadata.yaml']:
   result=branding.brand_skill_resource('./'+name,self.original(name)).decode()
   self.assertNotIn('Claude Science',result,name);self.assertNotIn('Anthropic',result,name);self.assertNotIn('claude.ai',result,name)
   document=result.split('---',2)[1] if result.startswith('---') else result if name.endswith('.yaml') else None
   if document is not None:
    parsed=subprocess.run(['node','--input-type=module','-e','import yaml from "js-yaml";import{readFileSync}from"node:fs";const value=yaml.load(readFileSync(0,"utf8"));if(!value||typeof value!=="object"||Array.isArray(value))process.exit(1)'],input=document,text=True,capture_output=True,cwd=ROOT)
    self.assertEqual(parsed.returncode,0,parsed.stderr)
  notice=self.original('skills/THIRD_PARTY_LICENSES.md');self.assertEqual(branding.brand_skill_resource('./skills/THIRD_PARTY_LICENSES.md',notice),notice)
 def test_new_modal_defaults_keep_existing_sandbox_ownership_and_app_lookup(self):
  source=branding.brand_skill_resource('./skills/remote-compute-modal/provider.py',self.original('skills/remote-compute-modal/provider.py')).decode();tree=ast.parse(source)
  values={}
  for node in tree.body:
   if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ['OWNER_TAG','LEGACY_OWNER_TAGS','LEGACY_APP_NAME','FALLBACK_APP_NAME','STAGING_APP_NAME']:values[node.targets[0].id]=ast.literal_eval(node.value)
  self.assertEqual(values['FALLBACK_APP_NAME'],'chimeric-default');self.assertEqual(values['OWNER_TAG'],'claude-science-install-id')
  method=next(node for cls in tree.body if isinstance(cls,ast.ClassDef) for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='list_owned')
  lookups=[];calls=[]
  class App:
   def __init__(self,name):self.app_id=name
  class Sandboxes:
   @staticmethod
   def list(**kwargs):calls.append(kwargs);return []
  class Modal:Sandbox=Sandboxes
  class Subject:
   _modal=Modal;_app_name='chimeric-current';_prior_app_names=['claude-science-previous']
   def _get_app(self):return App(self._app_name)
   def _lookup_existing_app(self,name):lookups.append(name);return App(name)
   def _map_err(self,error):return error
  environment={**values,'Any':typing.Any,'ByocError':type('ByocError',(Exception,),{})}
  exec(compile(ast.Module(body=[method],type_ignores=[]),'<bundled-modal-owner-check>','exec'),environment)
  self.assertEqual(environment['list_owned'](Subject(),'same-install'),[])
  self.assertIn('chimeric-default',lookups);self.assertIn('claude-science-default',lookups);self.assertIn('claude-science-previous',lookups)
  self.assertTrue(calls);self.assertTrue(all(list(call['tags'].values())==['same-install'] for call in calls))

 def test_seed_prompts_rebrand_product_identity_but_keep_provider_provenance(self):
  source=self.original('seed/manifest_mat_xrd.json')
  result=product_branding.brand_product_resource('./seed/manifest_mat_xrd.json',source)
  self.assertNotIn(b'Claude Science',result)
  self.assertNotIn(b'Anthropic infra and Git hosts for skill repos',result)
  self.assertIn(b'Chimeric',result)
  synthetic=(b'Claude Science ' * 4)+b'Anthropic infra and Git hosts for skill repos source=anthropic model=Claude Opus 5.5'
  preserved=product_branding.brand_product_resource('./seed/manifest_fixture.json',synthetic)
  self.assertIn(b'source=anthropic model=Claude Opus 5.5',preserved)

 def test_bio_tools_and_compute_messages_use_chimeric_identity(self):
  bio=product_branding.brand_product_resource('./mcp-servers/bio-tools/lib/mcp_servers_common/ua.py',self.original('mcp-servers/bio-tools/lib/mcp_servers_common/ua.py'))
  self.assertIn(b'_PRODUCT = "Chimeric"',bio)
  self.assertIn(b'https://github.com/sammanalili/chimeric',bio)
  self.assertNotIn(b'outside Claude Science',bio)
  wrapper=product_branding.brand_product_resource('./compute/wrapper.sh.tmpl',self.original('compute/wrapper.sh.tmpl'))
  self.assertIn(b'chimeric: WARN out/ is empty',wrapper)
  self.assertNotIn(b'claude-science: WARN out/ is empty',wrapper)

if __name__=='__main__':unittest.main()
