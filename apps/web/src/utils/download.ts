/**
 * 下载取回的内容。
 *
 * 为什么不直接把 `<a href={apiUrl}>` 丢给浏览器：
 * 那些端点要 `Authorization` 头，<a> 带不了，只能先 fetch 成 Blob 再触发下载。
 * 这和报告预览用 blob URL 是同一个原因——不为"能下载"而给接口开匿名口子。
 */
export function saveBlob(content: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器会让下载中断，留一个宽限窗口
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 产物类型 → 文件扩展名 */
export const extensionOf = (kind: string): string =>
  kind === "report_html" ? "html" : kind === "report_markdown" ? "md" : "json";

/** 尽量把 JSON 文本格式化；不是 JSON 就原样返回（不要吞掉内容） */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 报告预览与"新标签打开"共用：把 HTML 文本变成可引用的一次性 URL */
export function htmlToObjectUrl(html: string): string {
  return URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
}
