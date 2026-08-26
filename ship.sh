#!/bin/bash
set -euo pipefail

# コミットメッセージが指定されていない場合はエラーにする
if [ -z "${1:-}" ]; then
  echo "エラー: コミットメッセージを指定してください。"
  echo "使い方: ./ship.sh \"コミットメッセージ\""
  exit 1
fi

echo "--- 1. テストを実行します ---"
npm test
echo "✅ テスト成功！"

echo "--- 2. 変更をコミットしてプッシュします ---"
git add .
git commit -m "$1"
git push

echo "🚀 完了しました！"
