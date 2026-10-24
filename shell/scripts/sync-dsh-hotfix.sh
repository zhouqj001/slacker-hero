#!/usr/bin/env bash
# 把 vendor/dsh-runtime 里带本地 hotfix 的 dsh 包，同步到其它 dsh 副本。
#
# 背景：dsh 的 `reconcileProfilePatches()` 用**模块级 WeakMap** 记录 root Include 行，
# 由同模块实例的 `mountRootInclude()` 填充。同一份 dsh 存在多份拷贝时，
# 各拷贝各有各的 WeakMap——只有 boot 用的那一份被填过。
# 于是从 profile 依赖树解析到另一份拷贝的调用方（dsh-config-editor / dsh-settings，
# 也就是设置页保存模型配置的路径）查到 undefined，直接抛：
#     dsh: profile reload requires the root Include entry
#
# vendor/dsh-runtime 那份打了 hotfix（见文件内 "Local hotfix (slacker-hero)" 注释），
# 会沿 ctx.root 再沿 loader 兜底查找。其余拷贝是原始版本，没有兜底，必抛。
#
# 为什么需要脚本而不是手工拷：profile 的 node_modules 会被 `pnpm install --force`
# 还原成 tarball 里的原始版本，必须每次安装后重跑。deploy-media.sh 已挂上这一步。
set -uo pipefail
ROOT=/home/ubuntu/Downloads/slacker-hero
SRC=$ROOT/vendor/dsh-runtime/node_modules/@deepseek-ai

# 带本地 hotfix 的包（与 vendor 有差异的就是这几个，不要写死版本号）
# dsh-system-prompt: 同名 prompt 注册改替换（rc.2 per-agent 注册落全局层）
# dsh-scope: 跨副本 scope 身份（Symbol.for + 共享 WeakMap），修「第二个会话起
#   tool already registered」的上游双实例缺陷
PATCHED_PKGS="dsh-app-boot dsh-config-editor dsh-settings dsh-system-prompt dsh-scope"

TARGETS=(
  "$ROOT/.dsh-dev/shell-home/profiles/slacker/node_modules/@deepseek-ai"   # 运行时关键：配置写入走这里
  "$ROOT/shell/src-tauri/resources/runtime/dsh/node_modules/@deepseek-ai"        # 打包源
  "$ROOT/shell/src-tauri/target/debug/resources/runtime/dsh/node_modules/@deepseek-ai"  # tauri dev 产物
)

# 校验基准：vendor 那份必须真的带兜底，否则会把未打补丁的文件扩散出去
if ! grep -q 'resolve("include")' "$SRC/dsh-app-boot/lib/index.js"; then
  echo "❌ vendor/dsh-runtime 的 app-boot 没有 Include 兜底 hotfix，拒绝同步（会把坏文件复制开）"
  exit 1
fi

copied=0
for t in "${TARGETS[@]}"; do
  [ -d "$t" ] || continue
  for pkg in $PATCHED_PKGS; do
    src="$SRC/$pkg/lib/index.js"
    dst="$t/$pkg/lib/index.js"
    [ -f "$src" ] || continue
    [ -f "$dst" ] || continue
    if cmp -s "$src" "$dst"; then continue; fi
    cp "$src" "$dst"
    echo "  ✓ $pkg → ${t#$ROOT/}"
    copied=$((copied + 1))
  done
done

echo "  已同步 $copied 个文件"

# 复核：所有存在的副本必须与 vendor 一致
bad=0
for t in "${TARGETS[@]}"; do
  [ -d "$t" ] || continue
  for pkg in $PATCHED_PKGS; do
    src="$SRC/$pkg/lib/index.js"; dst="$t/$pkg/lib/index.js"
    [ -f "$dst" ] || continue
    cmp -s "$src" "$dst" || { echo "  ❌ 仍有差异: ${t#$ROOT/}/$pkg"; bad=$((bad + 1)); }
  done
done
[ "$bad" -eq 0 ] && echo "  ✅ 所有 dsh 副本的 hotfix 一致" || exit 1