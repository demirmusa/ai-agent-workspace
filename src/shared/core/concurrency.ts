/** Maps items with at most `limit` calls of `task` in flight, keeping the input order; used to bound child-process fan-out. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const index = next++; results[index] = await task(items[index]!, index); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
