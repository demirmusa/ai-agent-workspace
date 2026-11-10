/** Attachment references (markdown images/links, attachment URLs, image/file paths) are not title text. */
const ATTACHMENT_REF = /!?\[[^\]]*\]\([^)]*\)|\/api\/attachments\/\S*|[A-Za-z]:[\\/]\S+\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|zip|txt|md|json|log)\b/gi;

/** Title shown for a task: its own title, or the first 50 characters of its description (attachments left out) when the title is empty. */
export function taskTitle(task: { title: string; description: string }): string {
  if (task.title) return task.title;
  const flat = task.description.replace(ATTACHMENT_REF, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 50 ? `${flat.slice(0, 50)}...` : flat;
}
