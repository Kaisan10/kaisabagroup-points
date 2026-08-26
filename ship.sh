#!/bin/bash

# コミットメッセージが指定されていない場合はエラーにする
if [ -z "$1" ]; then
  echo "エラー: コミットメッセージを指定してください。"
  echo "使い方: ./ship.sh \"コミットメッセージ\""
  exit 1
fi

echo "--- 1. テストを実行します ---"
npm test

# テストが失敗した場合は中止する
if [ $? -ne 0 ]; then
  echo "❌ エラー: テストが失敗しました。コミットを中止します。"
  exit 1
fi
echo "✅ テスト成功！"

echo "--- 2. 変更をコミットしてプッシュします ---"
git add .
git commit -m "$1"
git push

echo "🚀 完了しました！"
