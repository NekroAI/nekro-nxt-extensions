/** 扩展 Client 导入的 CSS Module：默认导出类名到构建后类名的映射。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
