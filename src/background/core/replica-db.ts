// AUTHORED-BY Claude Opus 4.8
/**
 * The IndexedDB backing for the shared extension-owned replica:
 *   - the per-entry METADATA store (ETag / fetchedAt / contentType / status / scope) — the
 *     client analogue of QLever, the 1:1 companion of the bytes in the Cache API. Modelled
 *     on `@jeswr/solid-offline` `metadata-store.ts` (a thin promise-handle over one object
 *     store) but EXTENDED so the security-scoped composite key (which embeds WebID +
 *     grant-scope, see replica-key.ts) is the primary key, and so the WebID is a queryable
 *     column for the synchronous logout purge.
 *   - the DPoP NONCE store — moved off the in-memory `Map` so a cold SW wake does not pay the
 *     RFC 9449 §8 nonce round-trip on its first request (design §2.1 last bullet, §5.2).
 *
 * ONE IndexedDB database (`solid-ext-replica`) holds both object stores, so the extension
 * opens a single handle. All durable state lives here / in the Cache API / in
 * `chrome.storage.local`; nothing in this module is load-bearing in-memory (the open handle
 * is a re-derivable accelerator), keeping the MV3 "stateless on wake" invariant.
 */

/** The metadata record persisted per replica entry — the 1:1 companion of the bytes. */
export interface ReplicaMetadata {
  /** Composite primary key = the security-scoped `computeReplicaKey` string. */
  readonly key: string;
  /** The active WebID this entry belongs to (a queryable column for the logout purge). */
  readonly webId: string;
  /** The grant-scope (verified requesting origin) this entry was cached under. */
  readonly grantScope: string;
  /** The real resource URL (without the synthetic key wrapper). */
  readonly resourceUrl: string;
  /** The variant discriminator (canonical Accept). */
  readonly varyKey: string;
  /** The response ETag — drives the conditional `If-None-Match` revalidation. */
  readonly etag?: string;
  /** The response Content-Type. */
  readonly contentType?: string;
  /** HTTP status of the cached response. */
  readonly status: number;
  /** Epoch ms the entry was last confirmed fresh (set on 200, touched on 304). */
  readonly fetchedAt: number;
}

const DB_NAME = 'solid-ext-replica';
const DB_VERSION = 1;
const META_STORE = 'replica-metadata';
const NONCE_STORE = 'dpop-nonces';
const META_BY_WEBID = 'byWebId';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Open (or upgrade) the replica DB. The caller may inject an `indexedDB` factory (the test
 * suite injects `fake-indexeddb`); defaults to the global (present in the SW context).
 */
export function openReplicaDb(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!factory) {
    return Promise.reject(new Error('[solid-ext] no IndexedDB available in this context'));
  }
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const os = db.createObjectStore(META_STORE, { keyPath: 'key' });
        // The logout purge drops exactly one identity's rows — index the WebID column.
        os.createIndex(META_BY_WEBID, 'webId', { unique: false });
      }
      if (!db.objectStoreNames.contains(NONCE_STORE)) {
        // Nonce store keyed by resource origin → the freshest server DPoP nonce string.
        db.createObjectStore(NONCE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A promise-based handle over the replica's two IndexedDB stores. */
export class ReplicaDb {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: IDBFactory): Promise<ReplicaDb> {
    return new ReplicaDb(await openReplicaDb(factory));
  }

  // --- Metadata ------------------------------------------------------------------------

  async getMetadata(key: string): Promise<ReplicaMetadata | undefined> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    return promisify<ReplicaMetadata | undefined>(tx.objectStore(META_STORE).get(key));
  }

  async putMetadata(record: ReplicaMetadata): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    await promisify(tx.objectStore(META_STORE).put(record));
    await txDone(tx);
  }

  async deleteMetadata(key: string): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    await promisify(tx.objectStore(META_STORE).delete(key));
    await txDone(tx);
  }

  /** Every metadata row for a WebID (the rows a logout purge must drop + their byte keys). */
  async getMetadataByWebId(webId: string): Promise<ReplicaMetadata[]> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    const index = tx.objectStore(META_STORE).index(META_BY_WEBID);
    return promisify<ReplicaMetadata[]>(index.getAll(webId));
  }

  /** Delete every metadata row for a WebID (the metadata half of the logout purge). */
  async deleteMetadataByWebId(webId: string): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const index = store.index(META_BY_WEBID);
    const keys = await promisify<IDBValidKey[]>(index.getAllKeys(webId));
    for (const k of keys) await promisify(store.delete(k));
    await txDone(tx);
  }

  /** Drop ALL replica metadata (a full reset — e.g. a logout with an unknown prior WebID). */
  async clearMetadata(): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    await promisify(tx.objectStore(META_STORE).clear());
    await txDone(tx);
  }

  // --- DPoP nonce cache (survives SW restart) ------------------------------------------

  async getNonce(origin: string): Promise<string | undefined> {
    const tx = this.db.transaction(NONCE_STORE, 'readonly');
    return promisify<string | undefined>(tx.objectStore(NONCE_STORE).get(origin));
  }

  async setNonce(origin: string, nonce: string): Promise<void> {
    const tx = this.db.transaction(NONCE_STORE, 'readwrite');
    await promisify(tx.objectStore(NONCE_STORE).put(nonce, origin));
    await txDone(tx);
  }

  /** Clear every cached nonce (part of the logout purge — a new identity must not reuse them). */
  async clearNonces(): Promise<void> {
    const tx = this.db.transaction(NONCE_STORE, 'readwrite');
    await promisify(tx.objectStore(NONCE_STORE).clear());
    await txDone(tx);
  }

  close(): void {
    this.db.close();
  }
}
