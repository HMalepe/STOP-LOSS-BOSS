/**
 * R6.5 / ADR-0009: where did each entry end up? One shared rule for every broker so the mock and MetaApi can't drift.
 * Precedence: a position beats a pending order beats "still in flight" beats "not found".
 */
import type { PendingOrder, Position } from "@/domain/types";
import type { ReconcileKey, Reconciled } from "./BrokerProvider";

type NonEmpty = [string, ...string[]];

/** Identity of an entry: the batch magic AND the clientId (R9.1). Either alone is not enough. */
export const entryKey = (magic: number, clientId: string): string => `${String(magic)}|${clientId}`;

function indexBy(
  items: readonly { readonly id: string; readonly clientId?: string; readonly magic: number }[],
): Map<string, NonEmpty> {
  const out = new Map<string, NonEmpty>();
  for (const item of items) {
    if (item.clientId === undefined) continue;
    const key = entryKey(item.magic, item.clientId);
    const ids = out.get(key);
    if (ids === undefined) out.set(key, [item.id]);
    else ids.push(item.id);
  }
  return out;
}

export function reconcileFrom(
  keys: readonly ReconcileKey[],
  positions: readonly Position[],
  orders: readonly PendingOrder[],
  inFlight: ReadonlySet<string>,
): ReadonlyMap<string, Reconciled> {
  const byPos = indexBy(positions);
  const byOrder = indexBy(orders);
  const out = new Map<string, Reconciled>();
  for (const { clientId, magic } of keys) {
    const k = entryKey(magic, clientId);
    const pos = byPos.get(k);
    const ord = byOrder.get(k);
    out.set(
      clientId,
      pos !== undefined
        ? { status: "position", positionIds: pos }
        : ord !== undefined
          ? { status: "order", orderIds: ord }
          : inFlight.has(k)
            ? { status: "inFlight" }
            : { status: "notFound" },
    );
  }
  return out;
}
