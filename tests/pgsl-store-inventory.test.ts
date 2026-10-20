import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectInventory, controlLimit, existingConnection, inventoryExitCode, projectRows, safeFailure, SQL,
  type InventoryClient, type Query } from '../tools/pgsl-store-inventory.js';
import { cpKey, subspaceRange, SUBSPACE_PAYLOAD_OFFSET } from '../packages/pgsl-store/src/keyspace.js';

function client(overrides: (query: Query) => Record<string, unknown>[] | undefined = () => undefined) {
  const calls: Query[] = [];
  const api: InventoryClient = { async query(q) {
    calls.push(q);
    const rows = overrides(q);
    if (rows) return { rows };
    if (q.text === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: 'on' }] };
    if (q.text === SQL.database) return { rows: [{ database_bytes: '1000', server_version_num: '160004' }] };
    if (q.text === SQL.control_categories) return { rows: [{ category: 'native_lrs_artifact', records: '3', control_key_bytes: '90',
      control_metadata_bytes: '150', represented_resource_bytes: '3000000', size_metadata_records: '3', invalid_size_metadata_records: '0', truncated: true }] };
    return { rows: [] };
  } };
  return { api, calls };
}

describe('bounded metadata-only pod-store inventory', () => {
  it('succeeds for complete or deliberately capped reports while missing, unavailable or unknown measurements fail', async () => {
    const capped = await collectInventory(client().api, { maxControlRecords: 20 });
    const before = structuredClone(capped);
    expect(inventoryExitCode(capped)).toBe(0);
    expect(capped).toEqual(before); // Report status, cap flags and limitations remain visible.
    expect(capped.status).toBe('partial');

    const complete = await collectInventory(client(q => q.text === SQL.control_categories ? [] : undefined).api);
    expect(complete.status).toBe('ok');
    expect(inventoryExitCode(complete)).toBe(0);
    for (const name of ['database', 'relations', 'sessions', 'wal', 'slots', 'control_categories']) {
      const missing = structuredClone(complete);
      delete (missing.sections as Record<string, unknown>)[name];
      expect(inventoryExitCode(missing)).toBe(2);
      const unavailable = structuredClone(capped);
      (unavailable.sections as Record<string, unknown>)[name] = { status: 'unavailable' };
      expect(inventoryExitCode(unavailable)).toBe(2);
    }
    for (const name of ['relations', 'sessions', 'control_categories']) {
      const bounded = structuredClone(complete);
      bounded.status = 'partial';
      (bounded.sections as Record<string, Record<string, unknown>>)[name]!.truncated = true;
      expect(inventoryExitCode(bounded)).toBe(0);
    }
    for (const name of ['database', 'wal', 'slots', 'unknown']) {
      const invalid = structuredClone(complete);
      invalid.status = 'partial';
      (invalid.sections as Record<string, unknown>)[name] = { status: 'ok', truncated: true };
      expect(inventoryExitCode(invalid)).toBe(2);
    }
    const uncappedPartial = { ...complete, status: 'partial' };
    const malformedCap = structuredClone(capped);
    (malformedCap.sections as Record<string, Record<string, unknown>>).control_categories!.truncated = 'true';
    for (const invalid of [null, {}, { status: 'ok', sections: {} }, uncappedPartial,
      { ...capped, status: 'ok' }, malformedCap,
      { ...complete, status: 'error' }, { ...complete, status: undefined }]) expect(inventoryExitCode(invalid)).toBe(2);
  });

  it('uses read-only transactions and confirmed mode before every metadata SELECT, then rolls back', async () => {
    const h = client();
    const report = await collectInventory(h.api, { maxControlRecords: 20 });
    expect(report.status).toBe('partial'); // A capped prefix explicitly reports incomplete C coverage.
    const starts = h.calls.filter(q => q.text === 'BEGIN READ ONLY');
    expect(starts).toHaveLength(6);
    expect(h.calls.filter(q => q.text === 'ROLLBACK')).toHaveLength(6);
    expect(h.calls.filter(q => q.text === "SET LOCAL temp_file_limit = '0'")).toHaveLength(6);
    for (const q of h.calls) {
      expect(q.query_timeout).toBeGreaterThan(0);
      expect(q.query_timeout).toBeLessThanOrEqual(5000);
      const tokens = q.text.replace(/'(?:[^']|'')*'/g, "''");
      expect(tokens).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|VACUUM|ANALYZE|COMMIT)\b/i);
    }
    const control = h.calls.findIndex(q => q.text === SQL.control_categories);
    expect(h.calls[control - 1]?.text).toBe('SHOW transaction_read_only');
    expect(report).toMatchObject({ sections: { control_categories: { row_limit: 20, truncated: true, representative: false,
      order: 'lexicographic_prefix', rows: [{ represented_resource_bytes: '3000000', control_metadata_bytes: '150' }] } } });
  });

  it('refuses metadata SELECTs when read-only mode is not confirmed', async () => {
    const h = client(q => q.text === 'SHOW transaction_read_only' ? [{ transaction_read_only: 'off' }] : undefined);
    const report = await collectInventory(h.api);
    expect(report.status).toBe('partial');
    expect(h.calls.some(q => Object.values(SQL).includes(q.text))).toBe(false);
    expect(JSON.stringify(report)).toContain('read_only_not_confirmed');
    expect(h.calls.filter(q => q.text === 'ROLLBACK')).toHaveLength(5); // C JSON parsing is refused without a confirmed PG16 version.
  });

  it('isolates unavailable optional metadata and emits no server exception or query text', async () => {
    const h = client(q => {
      if (q.text === SQL.wal) throw Object.assign(new Error('postgres://private-user:password@private-host secret statement'), { code: '42501' });
      return undefined;
    });
    const report = await collectInventory(h.api);
    expect(report).toMatchObject({ status: 'partial', sections: { wal: { status: 'unavailable', sqlstate: '42501' }, slots: { status: 'ok' }, control_categories: { status: 'ok' } } });
    expect(JSON.stringify(report)).not.toMatch(/password|private-host|private-user|secret statement/);
  });

  it('reports sentinel truncation without printing the extra relation or session group', async () => {
    const h = client(q => q.text === SQL.relations ? Array.from({ length: 129 }, () => ({ relation: 'pgsl_kv', tables: '1' })) : undefined);
    const report = await collectInventory(h.api);
    expect(report).toMatchObject({ status: 'partial', sections: { relations: { group_limit: 128, truncated: true } } });
    const sections = report.sections as Record<string, { rows: unknown[] }>;
    expect(sections.relations!.rows).toHaveLength(128);
  });

  it('uses the actual byte-encoded C range, separator offset and a bounded indexed prefix', async () => {
    const h = client();
    await collectInventory(h.api, { maxControlRecords: 30 });
    const query = h.calls.find(q => q.text === SQL.control_categories)!;
    const range = subspaceRange('C');
    expect(query.values).toEqual([Buffer.from(range.begin), Buffer.from(range.end), 30, SUBSPACE_PAYLOAD_OFFSET + 1]);
    expect(Buffer.from(range.begin).toString('hex')).toBe('7067736c0043');
    expect(Buffer.from(range.end).toString('hex')).toBe('7067736c0044');
    const key = cpKey('ldp private-pod', 'foxxi/lrs/native/head');
    const payload = key.slice(SUBSPACE_PAYLOAD_OFFSET), separator = payload.indexOf(0);
    expect(new TextDecoder().decode(payload.slice(separator + 1))).toBe('foxxi/lrs/native/head');
    expect(query.text).toContain('k >= $1 AND k < $2 ORDER BY k LIMIT ($3::integer + 1)');
    expect(query.text).toContain("position(decode('00', 'hex') IN payload)");
    expect(query.text).not.toMatch(/convert_from\(k|SELECT\s+\*\s+FROM\s+public\.pgsl_kv/i);
  });

  it('whitelists output fields and categories even when driver rows contain private identities or payloads', () => {
    const rows = [{ relation: 'private_tenant_name', category: '/private-pod/secret-record', application: 'private@example.com',
      state: 'password', wait_type: 'secret', payload: 'private medical record', password: 'dont-print', records: '3', control_metadata_bytes: '42' }];
    for (const section of ['relations', 'control_categories', 'sessions']) {
      const text = JSON.stringify(projectRows(section, rows));
      expect(text).not.toMatch(/private|password|secret|dont-print|medical|example\.com/);
    }
    expect(projectRows('control_categories', [{ category: 'native_lrs_artifact', records: '4' }])).toMatchObject([{ category: 'native_lrs_artifact', records: '4' }]);
    expect(safeFailure(Object.assign(new Error('sensitive'), { code: 'ECONNREFUSED' }))).toEqual({ status: 'unavailable', reason: 'query_unavailable' });
  });

  it('does no SQL when the remaining overall budget is exhausted and refuses unsafe limits', async () => {
    const h = client();
    const report = await collectInventory(h.api, { remainingMs: () => 0 });
    expect(h.calls).toEqual([]);
    expect(report.status).toBe('partial');
    for (const limit of [0, -1, 50001, NaN, Infinity, 1.5, '4;DROP TABLE pgsl_kv', ' 20 ']) expect(() => controlLimit(limit)).toThrow();
    expect(controlLimit('50000')).toBe(50000);
  });

  it('stops after an unconfirmed rollback instead of starting another diagnostic transaction', async () => {
    const h = client(q => {
      if (q.text === 'ROLLBACK') throw new Error('private connection failure');
      return undefined;
    });
    await expect(collectInventory(h.api)).rejects.toThrow('rollback_unconfirmed');
    expect(h.calls.filter(q => q.text === 'BEGIN READ ONLY')).toHaveLength(1);
  });

  it('reuses exactly one existing proxy and never requests an infrastructure mutation', async () => {
    const queries: string[] = [];
    const gql = async (query: string) => {
      queries.push(query);
      if (query.includes('projectToken')) return { projectToken: { projectId: 'p', environmentId: 'e' } };
      if (query.includes('services')) return { project: { services: { edges: [{ node: { id: 's', name: 'postgres' } }] } } };
      return { tcpProxies: [{ applicationPort: 5432, domain: 'existing.proxy.rlwy.net', proxyPort: 12345 }],
        variables: { POSTGRES_USER: 'private-user', POSTGRES_PASSWORD: 'private-password', POSTGRES_DB: 'private-db' } };
    };
    const connection = await existingConnection(gql);
    expect(connection).toMatchObject({ host: 'existing.proxy.rlwy.net', port: 12345, application_name: 'pgsl-storage-inventory' });
    expect(connection.options).toContain('default_transaction_read_only=on');
    expect(queries.every(q => /^query\b/.test(q))).toBe(true);
    expect(queries.join('\n')).not.toMatch(/mutation|tcpProxyCreate|tcpProxyDelete/);
  });

  it('refuses absent/ambiguous proxies or redacted credentials without creating access', async () => {
    for (const detail of [
      { tcpProxies: [], variables: {} },
      { tcpProxies: [{ applicationPort: 5432, domain: 'one.proxy.rlwy.net', proxyPort: 1 },
        { applicationPort: 5432, domain: 'two.proxy.rlwy.net', proxyPort: 2 }], variables: {} },
      { tcpProxies: [{ applicationPort: 5432, domain: 'evil.example', proxyPort: 1 }], variables: {} },
      { tcpProxies: [{ applicationPort: 5432, domain: 'existing.proxy.rlwy.net', proxyPort: 1 }], variables: {} },
    ]) {
      const calls: string[] = [];
      await expect(existingConnection(async q => {
        calls.push(q);
        if (q.includes('projectToken')) return { projectToken: { projectId: 'p', environmentId: 'e' } };
        if (q.includes('services')) return { project: { services: { edges: [{ node: { id: 's', name: 'postgres' } }] } } };
        return detail;
      })).rejects.toThrow();
      expect(calls.every(q => /^query\b/.test(q))).toBe(true);
    }
  });

  it('is manual-only and limits runtime without introducing a schedule or credential output', () => {
    const workflow = readFileSync(new URL('../.github/workflows/pgsl-store-inventory.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s+(?:schedule|push|pull_request):/m);
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('contents: read');
    const source = readFileSync(new URL('../tools/pgsl-store-inventory.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/readFileSync|spawn\(|tcpProxyCreate|process\.env\[['"]PGSL_PG_CONNSTR/);
    expect(source).toContain('}, MAX_RUNTIME_MS)');
  });
});
