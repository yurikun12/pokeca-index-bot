# Pokeca Index Bot

pokeca-chart.com の3指数を取得する最小構成です。

- 美品指数: `index_0`
- PSA10指数: `index_2`
- BOX指数: PlaywrightでBOX指数ページを開き、React内の復号済み `allData` を取得

## 出力
- `data/latest.json`
- `data/raw-index.json`
- `data/psa10-index.json`
- `data/box-index.json`

## 最初のテスト
GitHubにこのフォルダ一式をアップロードし、
Actions → Fetch Pokeca Indices → Run workflow
を実行してください。

最初は手動実行だけにしています。成功確認後に毎朝のcronを追加します。
