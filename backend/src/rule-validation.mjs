import { createHash } from 'node:crypto';

export const VERIFIED_RULE_PRIORITY = 2147483647;
export const REQUIRED_RULE_CHECKS = ['composer', 'threads', 'model', 'effort', 'speed', 'usage', 'send', 'reply', 'restore'];
export function ruleDigest(rules) {
  const { collector, ...operations } = rules;
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(operations))).digest('hex');
}
export function validateRuleDocument(rules) {
  if (!rules || rules.schemaVersion !== 1 || !/^[a-zA-Z0-9._-]{1,128}$/.test(rules.id || '')) throw new Error('CDP 规则 ID 或格式无效');
  for (const name of ['composer', 'composerRootMarker', 'modelTrigger', 'profileTrigger', 'threadRow', 'threadTitleRow']) {
    const value = rules.selectors?.[name];
    if (typeof value !== 'string' || !value || value.length > 500 || /[{};]|javascript:/i.test(value)) throw new Error(`无效选择器：${name}`);
  }
  if (typeof rules.labels?.usage !== 'string' || !Array.isArray(rules.labels?.queued)) throw new Error('缺少规则标签');
  for (const value of [rules.labels.usage, ...rules.labels.queued]) {
    if (typeof value !== 'string' || value.length > 80) throw new Error('规则标签无效');
  }
  if (Object.values(rules.selectors).some(value => typeof value !== 'string' || !value || value.length > 500 || /[{};]|javascript:/i.test(value))) throw new Error('无效选择器');
  if (rules.appServer) for (const [key, values] of Object.entries(rules.appServer)) {
    if (!['threadListPaths', 'threadIdFields', 'threadTitleFields'].includes(key) || !Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || value.length > 120 || (value === '' ? key !== 'threadListPaths' : !/^[A-Za-z0-9_.-]+$/.test(value)))) throw new Error('app-server 映射无效');
  }
  return rules;
}
export function requireFunctionalValidation(rules, platform) {
  validateRuleDocument(rules);
  const report = rules.collector?.validation;
  const capability = rules.collector?.capabilities;
  if (['runtime', 'mainWindow', 'documentReady', 'composer', 'submitControl', 'composerVisible'].some(name => capability?.[name] !== true) || !(rules.collector?.selectorMatches?.composer > 0) || !(rules.collector?.selectorMatches?.submitControl > 0)) throw new Error('采集器未确认消息交互界面');
  if (!report || report.suite !== 'gpttool-functional-v1' || report.status !== 'passed') throw new Error('规则尚未通过实际功能验证，不能上传或启用');
  if (!rules.exactOfficialVersion || report.officialVersion !== rules.exactOfficialVersion) throw new Error('验证版本与规则版本不一致');
  if (!['darwin', 'win32'].includes(platform) || report.platform !== platform) throw new Error('已验证规则只能应用于实际测试的平台');
  const timestamp = Date.parse(report.validatedAt);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300_000) throw new Error('功能验证时间无效');
  if (report.rulesDigest !== ruleDigest(rules)) throw new Error('规则内容在验证后发生变化，需要重新验证');
  if (REQUIRED_RULE_CHECKS.some((name) => report.checks?.[name]?.status !== 'passed')) throw new Error('功能验证不完整，不能发布');
  return report;
}
export function validPriority(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < -1000 || number > VERIFIED_RULE_PRIORITY) throw new Error('规则优先级超出范围');
  return number;
}
