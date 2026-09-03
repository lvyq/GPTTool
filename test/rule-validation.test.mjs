import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDigest, requireFunctionalValidation, VERIFIED_RULE_PRIORITY, REQUIRED_RULE_CHECKS } from '../backend/src/rule-validation.mjs';
import { PostgresRelayStore } from '../backend/src/postgres-store.mjs';

function fixture() {
  const rules = {schemaVersion:1,id:'validated-fixture',exactOfficialVersion:'26.901.20858 (7658)',updatedAt:new Date().toISOString(),selectors:Object.fromEntries(['composer','composerRootMarker','modelTrigger','profileTrigger','threadRow','threadTitleRow'].map(key=>[key,`[data-${key.toLowerCase()}]`])),labels:{usage:'usage',queued:['queued']}};
  rules.collector={capabilities:Object.fromEntries(['runtime','mainWindow','documentReady','composer','submitControl','composerVisible'].map(key=>[key,true])),selectorMatches:{composer:1,submitControl:1},validation:{suite:'gpttool-functional-v1',status:'passed',officialVersion:rules.exactOfficialVersion,platform:'darwin',validatedAt:new Date().toISOString(),rulesDigest:ruleDigest(rules),checks:Object.fromEntries(REQUIRED_RULE_CHECKS.map(key=>[key,{status:'passed'}]))}};
  return rules;
}
test('publishing requires every actual function check, exact version/platform and untampered rules',()=>{
  const rules=fixture();assert.equal(requireFunctionalValidation(rules,'darwin').status,'passed');
  for(const key of REQUIRED_RULE_CHECKS){const failed=structuredClone(rules);failed.collector.validation.checks[key].status='failed';assert.throws(()=>requireFunctionalValidation(failed,'darwin'),/不完整/)}
  const changed=structuredClone(rules);changed.selectors.composer='textarea';assert.throws(()=>requireFunctionalValidation(changed,'darwin'),/发生变化/);
  const old=structuredClone(rules);delete old.collector.validation;assert.throws(()=>requireFunctionalValidation(old,'darwin'),/尚未通过/);
  assert.throws(()=>requireFunctionalValidation(rules,'all'),/实测|测试的平台/);
  const mismatched=structuredClone(rules);mismatched.collector.validation.officialVersion='old';assert.throws(()=>requireFunctionalValidation(mismatched,'darwin'),/版本/);
});
test('rule timestamps preserve unknown historical uploads and publishing records a new upload time',async()=>{
  const calls=[];const rules=fixture();
  const store=new PostgresRelayStore({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{id:rules.id,platform:'darwin',payload:rules,enabled:true,priority:10,updatedAt:'123',uploadedAt:null}],rowCount:1}}});
  assert.equal((await store.listCdpRules())[0].uploadedAt,null);
  await store.putCdpRules(rules,'darwin',VERIFIED_RULE_PRIORITY);
  assert.match(calls.at(-1).sql,/uploaded_at = EXCLUDED.uploaded_at/);
  assert.equal(calls.at(-1).args[3],VERIFIED_RULE_PRIORITY);
  await store.updateCdpRule(rules.id,{priority:9},'actor');
  assert.ok(calls.some(call=>/^UPDATE cdp_rule_sets/.test(call.sql)&&!call.sql.includes('uploaded_at')));
  const changed=structuredClone(rules);changed.selectors.composer='textarea';
  await assert.rejects(store.updateCdpRule(rules.id,{rules:changed},'actor'),/发生变化/);
  await store.deleteCdpRule(rules.id,'actor');
  assert.ok(calls.some(call=>call.sql==='DELETE FROM cdp_rule_sets WHERE id = $1'));
});
