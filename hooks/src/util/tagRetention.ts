const TTL_SUFFIX_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "90d": 90 * 24 * 60 * 60,
  "180d": 180 * 24 * 60 * 60,
  "365d": 365 * 24 * 60 * 60,
  "1month": 30 * 24 * 60 * 60,
  "3month": 90 * 24 * 60 * 60,
  "6month": 180 * 24 * 60 * 60,
  "12month": 365 * 24 * 60 * 60,
};

const TTL_CANONICAL_SUFFIX: Record<string, string> = {
  "1h": "1h",
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "180d": "180d",
  "365d": "365d",
  "1month": "30d",
  "3month": "90d",
  "6month": "180d",
  "12month": "365d",
};

const TTL_TAG_PATTERN = /^(.*)--(ttl|idle)-([a-z0-9]+)$/;

export type RetentionMode = "keep-latest" | "ttl" | "idle";

export interface ParsedTagRetention {
  retentionMode: RetentionMode;
  retentionValueSeconds: number | null;
  expiresAt: Date | null;
  rawRetentionSuffix: string | null;
  canonicalRetentionSuffix: string | null;
}

export function parseTagRetention(tag: string, referenceTime: Date = new Date()): ParsedTagRetention {
  const match = TTL_TAG_PATTERN.exec(tag);
  if (match == null) {
    return {
      retentionMode: "keep-latest",
      retentionValueSeconds: null,
      expiresAt: null,
      rawRetentionSuffix: null,
      canonicalRetentionSuffix: null,
    };
  }

  const retentionType = match[2] as "ttl" | "idle";
  const rawRetentionSuffix = match[3];
  const retentionValueSeconds = TTL_SUFFIX_SECONDS[rawRetentionSuffix];
  if (retentionValueSeconds == null) {
    return {
      retentionMode: "keep-latest",
      retentionValueSeconds: null,
      expiresAt: null,
      rawRetentionSuffix: null,
      canonicalRetentionSuffix: null,
    };
  }

  return {
    retentionMode: retentionType,
    retentionValueSeconds,
    expiresAt: retentionType === "ttl" ? new Date(referenceTime.getTime() + retentionValueSeconds * 1000) : null,
    rawRetentionSuffix,
    canonicalRetentionSuffix: TTL_CANONICAL_SUFFIX[rawRetentionSuffix],
  };
}
