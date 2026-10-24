/**
 * CSS modules 没有类型产物：styles.module.css 经 tsdown lightningcss 编译成
 * 带哈希类名的注入器，编译期把类名表视为 Record<string, string>。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
