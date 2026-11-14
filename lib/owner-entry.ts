/**
 * The owner's door: typing ZANOX in capitals on the normal login screen opens the
 * owner centre. Nothing on screen changes while it is typed, so a visitor sees no
 * hint that an owner area exists.
 */
export function isOwnerEntryWord(value: string): boolean {
  return value.trim() === "ZANOX";
}
