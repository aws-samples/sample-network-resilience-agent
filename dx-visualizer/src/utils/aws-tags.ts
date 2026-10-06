/** Normalize the two tag shapes returned by the AWS SDK without losing empty values. */
export function tagsToRecord(
  tags: readonly { Key?: string; Value?: string; key?: string; value?: string }[] | undefined,
): Record<string, string> {
  return Object.fromEntries((tags ?? []).flatMap((tag) => {
    const key = tag.Key ?? tag.key;
    return key ? [[key, tag.Value ?? tag.value ?? '']] : [];
  }));
}
