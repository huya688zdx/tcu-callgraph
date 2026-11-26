export const MAX_CODE_ATTACHMENTS = 4;
export const MAX_CODE_ATTACHMENT_CHARS = 24_000;
const MAX_SAVED_CODE_CHARS = 240_000;

export function sanitizeCodeAttachments(items, maxChars = MAX_CODE_ATTACHMENTS * MAX_CODE_ATTACHMENT_CHARS) {
  const files = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : '';
    const content = typeof item.content === 'string' ? item.content.slice(0, Math.min(maxChars, MAX_CODE_ATTACHMENT_CHARS)) : '';
    if (!name || !content.trim()) continue;
    const startLine = Number.isInteger(item.startLine) && item.startLine > 0 ? item.startLine : 1;
    const endLine = Number.isInteger(item.endLine) && item.endLine >= startLine ? item.endLine : undefined;
    const totalLines = Number.isInteger(item.totalLines) && item.totalLines > 0 ? item.totalLines : undefined;
    files.push({ name, content, startLine, ...(endLine && { endLine }), ...(totalLines && { totalLines }),
      ...((item.truncated === true || content.length < item.content.length) && { truncated: true }) });
    maxChars -= content.length;
    if (files.length === MAX_CODE_ATTACHMENTS || maxChars === 0) break;
  }
  return files;
}

/** 限制要保存的副本，优先保留当前对话和各对话最新的代码片段。 */
export function boundSavedCodeAttachments(threads, activeId) {
  let remaining = MAX_SAVED_CODE_CHARS;
  const newestFirst = [...threads].sort((a, b) =>
    Number(b.id === activeId) - Number(a.id === activeId) || b.updatedAt - a.updatedAt);
  for (const thread of newestFirst) {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const message = thread.messages[i];
      if (!message.attachedFiles) continue;
      const files = sanitizeCodeAttachments(message.attachedFiles, remaining);
      if (files.length) {
        message.attachedFiles = files;
        for (const file of files) remaining -= file.content.length;
      } else {
        delete message.attachedFiles;
      }
    }
  }
}
