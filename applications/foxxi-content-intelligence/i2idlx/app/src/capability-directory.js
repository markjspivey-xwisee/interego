// Live capability-directory helpers. Keep transport and payload validation separate from React.
// Raw credentials belong to the connected client's key provider, never the generic runner.
const clientPlaceholder = "<provided by your connected client>";
const bearerPattern = /\bBearer\s+\S+/i;
export function isCredentialField(name) { const normalized = String(name).replace(/[^a-z0-9]/gi, "").toLowerCase(); return normalized === "key" || /privatekey|privkey|password|passwd|mnemonic|seed|secret|apikey|authorization|authheader|bearer|accesstoken|refreshtoken|sessiontoken|callertoken|token$|signature|signedpayload/.test(normalized); }
export function credentialPaths(value, path = "", allowPlaceholders = false) {
  if (typeof value === "string") return bearerPattern.test(value) || (!allowPlaceholders && value === clientPlaceholder) ? [path || "payload"] : [];
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [name, item] of Object.entries(value)) {
    const next = path ? path + "." + name : name;
    if (isCredentialField(name) && item != null && item !== "" && !(allowPlaceholders && item === clientPlaceholder)) paths.push(next);
    else paths.push(...credentialPaths(item, next, allowPlaceholders));
  }
  return paths;
}
export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (typeof value === "string") return value.replace(new RegExp(bearerPattern.source, "gi"), "Bearer " + clientPlaceholder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, isCredentialField(name) ? clientPlaceholder : redactCredentials(item)]));
}
export function directoryRequestBody(action, payload, mode) {
  if (credentialPaths(payload, "", mode === "validate").length) throw new Error("Raw credentials cannot be sent to this runner. Remove them and use your connected client's key provider.");
  return JSON.stringify({ action_iri: actionIri(action), payload, mode });
}
export function actionIri(action) { return action.iri || action.action || ""; }
export function actionName(action) { return action.n || action.name || actionIri(action).split("/").pop(); }
export function actionId(action) { const parts = actionIri(action).split("/"), tail = parts.pop(), namespace = parts.pop(); const system = ["foxxi", "relay", "llm-telemetry"].includes(namespace) ? namespace : action.sys; return "act-" + system + "." + (tail || actionName(action)); }
export function actionInputs(action) {
  if (action.input_schema && action.input_schema.properties) {
    const required = new Set(action.input_schema.required || []);
    return Object.entries(action.input_schema.properties).map(([n, schema]) => ({ n, req: required.has(n), c: schema.description || "", t: schema.type, schema }));
  }
  return action.in || [];
}
export function initialPayload(action) {
  let payload = {};
  if (action.example && Object.prototype.hasOwnProperty.call(action.example, "payload")) payload = redactCredentials(action.example.payload);
  else if (action.example != null) payload = redactCredentials(action.example);
  for (const field of actionInputs(action)) {
    if (field.req && isCredentialField(field.n) && !Object.prototype.hasOwnProperty.call(payload, field.n)) payload[field.n] = clientPlaceholder;
    else if (field.schema && Object.prototype.hasOwnProperty.call(field.schema, "default") && !Object.prototype.hasOwnProperty.call(payload, field.n)) payload[field.n] = field.schema.default;
  }
  return payload;
}
export function parsePayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { error: "Enter valid JSON." }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "The request payload must be a JSON object." };
  return { value };
}
const knownTypes = new Set(['string', 'boolean', 'number', 'integer', 'object', 'array', 'null']);
const fieldType = (field) => (field.schema && field.schema.type) || (knownTypes.has(field.t) ? field.t : 'string');
const matchesType = (value, type) => {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  if (!type) return true;
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
};
export function validatePayload(action, value) {
  for (const field of actionInputs(action)) {
    const present = Object.prototype.hasOwnProperty.call(value, field.n);
    if (field.req && (!present || value[field.n] === "")) return field.n + " is required.";
    if (!present) continue;
    const schema = field.schema || {};
    if (!matchesType(value[field.n], fieldType(field))) return field.n + " must be " + (schema.type || field.t) + ".";
    if (Array.isArray(schema.enum) && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value[field.n]))) return field.n + " must use an advertised value.";
  }
  return null;
}
export function fieldValue(value, field) {
  const v = value[field.n];
  return v === undefined ? "" : typeof v === "object" || Array.isArray(fieldType(field)) ? JSON.stringify(v, null, 2) : String(v);
}
export function editField(payload, field, text) {
  const next = { ...payload };
  if (text === "") { delete next[field.n]; return { value: next }; }
  const type = fieldType(field);
  try {
    next[field.n] = Array.isArray(type) || type === "boolean" || type === "number" || type === "integer" || type === "object" || type === "array" || type === "null" ? JSON.parse(text) : text;
    if (!matchesType(next[field.n], type)) return { error: field.n + " must be " + type + "." };
    return { value: next };
  } catch { return { error: field.n + " needs valid " + (type || "JSON") + "." }; }
}
export function describeCapability(action) {
  const execution = action.execution || {};
  if (execution.mode === "unavailable" || execution.mode === "blocked") return { label: "Unavailable", reason: execution.reason || "This operation has no available executor.", canRun: false };
  if (execution.mode === "client-only") return { label: "Connected client only", reason: execution.reason || "Prepare this operation in your connected client with its own identity and key provider.", canRun: false };
  if (execution.mode === "public-example") return { label: "Live example available", reason: execution.reason || "Run this advertised example and inspect its actual response.", canRun: true };
  if (execution.mode === "client-required") return { label: "Client required", reason: execution.reason || "Prepares a real task for your connected AI client; this server does not run a model.", canRun: true };
  return { label: "Prepare only", reason: execution.reason || "Validate the inputs and prepare an Interego call. This operation is not executed by this page.", canRun: false };
}
export function capabilityCall(action, payload, manifest) {
  const prepared = redactCredentials(payload);
  for (const field of actionInputs(action)) if (field.req && isCredentialField(field.n)) prepared[field.n] = "<provided by your connected client>";
  return action.sys === "relay" ? actionName(action).replace(/^relay[./]/, "") + " " + JSON.stringify(prepared, null, 2) :
    JSON.stringify({ descriptor_url: manifest, action_iri: actionIri(action), payload: prepared }, null, 2);
}
export function resultLabel(result, action) {
  if (!result) return "Not tried";
  if (result.status === "executed" && result.executed === true) return action && action.execution && action.execution.mode === "client-required" ? "Client task prepared" : "Executed";
  if (result.status === "contract-valid") return "Inputs valid · not executed";
  if (result.status === "invalid") return "Invalid inputs · not executed";
  if (result.status === "refused") return "Refused · not executed";
  return "Request failed";
}

// This editor produces copyable public preparation data only; it has no transport.
export function localSigningPayload(signing, text) {
  const parsed = parsePayload(text);
  if (parsed.error) return parsed;
  const expected = signing.payload || {};
  if (expected.action && parsed.value.action !== expected.action) return { error: "Keep the advertised action binding unchanged." };
  if (expected.bridge_audience && parsed.value.bridge_audience !== expected.bridge_audience) return { error: "Keep the advertised bridge_audience unchanged." };
  return {
    value: redactCredentials(parsed.value),
    warning: credentialPaths(parsed.value, "", true).length ? "Credential values are omitted from the prepared copy. Supply credentials only through your connected client's key provider." : validatePayload({ input_schema: signing.schema }, parsed.value),
  };
}
