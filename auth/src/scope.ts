// Distribution token-server `scope` handling, shared by /v2/token and the
// wrapped-upstream strategy so both read the parameter the same way.
//
// The token spec lets a client repeat `scope`, and containerd always does on a
// push (`repository:X:pull` and `repository:X:pull,push`). Express hands a
// repeated param over as an array, so nothing may treat `req.query.scope` as a
// string. The spec grammar also allows several space-separated resource scopes
// inside one value; repository names cannot contain whitespace, so splitting on
// it is safe.

export interface RequestedScope {
  type: string;
  name: string;
  actions: string[];
}

// Every requested resource is authorized individually: wrapped-upstream probes
// the upstream once per repository and the api strategy upserts one repository
// row each. Real clients ask for two or three (a push plus its cross-repo-mount
// sources), so a small cap stops one request from fanning out into hundreds of
// upstream probes. 20 matches the array limit of Express's query parser, past
// which repeated params already arrive as an object and are ignored.
export const MAX_REQUESTED_SCOPES = 20;

function scopeValues(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(/\s+/))
    .filter((value) => value.length > 0);
}

// type = text before the first ':', actions = text after the last ':', name =
// everything between, so a name carrying a registry port (`host:5000/app`)
// still parses. Entries without both separators, or with an empty type or
// name, are malformed and yield null.
export function parseScope(value: string): RequestedScope | null {
  const firstColon = value.indexOf(':');
  const lastColon = value.lastIndexOf(':');
  if (firstColon <= 0 || lastColon === firstColon) {
    return null;
  }

  const name = value.slice(firstColon + 1, lastColon);
  if (!name) {
    return null;
  }

  return {
    type: value.slice(0, firstColon),
    name,
    actions: value.slice(lastColon + 1).split(',').filter((action) => action.length > 0),
  };
}

// Normalizes a raw `scope` query value (string, array, or anything else) into
// one entry per (type, name), merging and de-duplicating the actions requested
// for the same resource. Non-string and malformed entries are dropped, which
// can only narrow what a token grants. Order is first-seen.
export function parseRequestedScopes(raw: unknown): RequestedScope[] {
  const merged = new Map<string, RequestedScope>();

  for (const value of scopeValues(raw)) {
    const parsed = parseScope(value);
    if (!parsed) {
      continue;
    }

    // type never contains ':' (it ends at the first one), so this key is unambiguous.
    const key = `${parsed.type}:${parsed.name}`;
    const entry = merged.get(key) ?? { type: parsed.type, name: parsed.name, actions: [] };
    for (const action of parsed.actions) {
      if (!entry.actions.includes(action)) {
        entry.actions.push(action);
      }
    }
    merged.set(key, entry);
  }

  return Array.from(merged.values());
}
