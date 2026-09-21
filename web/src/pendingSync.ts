export function watchPendingStorage(
  storageKey: string,
  listener: (raw: string | null) => void,
): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && event.key === storageKey) {
      listener(event.newValue);
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
