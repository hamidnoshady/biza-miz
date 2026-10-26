export interface AiAttachmentSource {
  library: "media" | "cms" | "wordpress";
  id: string;
  connectionId?: string;
  remoteId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseAttachmentSource(raw: unknown): AiAttachmentSource | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  if (row.library === "cms" && /^[A-Za-z0-9_-]{1,64}$/.test(row.id)) return { library: "cms", id: row.id };
  if (!UUID.test(row.id)) return null;
  if (row.library === "media") return { library: "media", id: row.id };
  if (row.library === "wordpress" && typeof row.connectionId === "string" && UUID.test(row.connectionId) &&
    typeof row.remoteId === "string" && /^[0-9]{1,20}$/.test(row.remoteId)) {
    return { library: "wordpress", id: row.id, connectionId: row.connectionId, remoteId: row.remoteId };
  }
  return null;
}
