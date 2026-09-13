/** Clipboard file handles must be captured synchronously during the paste
 * event. Browsers seal the data store when the handler yields. */
export function clipboardImages(items: DataTransferItemList): File[] {
  return Array.from(items).flatMap((item) => {
    const file = item.type.startsWith("image/") ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/** Browser-native encoding avoids constructing a second binary string with
 * a large synchronous JavaScript loop on the renderer thread. */
export function imageBase64(file: File): Promise<string> {
  if (file.size > 50 * 1024 * 1024) return Promise.reject(new Error("The pasted image exceeds 50 MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.onabort = () => reject(new Error("Reading the pasted image was cancelled"));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string" || !value.includes(";base64,")) reject(new Error("Could not encode the pasted image"));
      else resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function createAttachmentPreparationTracker() {
  const pending = new Map<string, Set<Promise<void>>>();
  return {
    track(key: string, preparation: Promise<void>): Promise<void> {
      const entries = pending.get(key) ?? new Set<Promise<void>>();
      entries.add(preparation);
      pending.set(key, entries);
      void preparation.finally(() => {
        entries.delete(preparation);
        if (!entries.size) pending.delete(key);
      }).catch(() => undefined);
      return preparation;
    },
    async wait(key: string): Promise<void> {
      while (pending.get(key)?.size) await Promise.allSettled([...pending.get(key)!]);
    },
  };
}
