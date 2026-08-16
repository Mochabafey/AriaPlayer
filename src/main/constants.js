/** 音质档位 → 文件扩展名 / 码率（下载与子进程 SELECT_MAX_BR 共用） */
export const QUALITY_MAP = {
  '128000': { ext: 'mp3', br: 128000 },
  '320000': { ext: 'mp3', br: 320000 },
  lossless: { ext: 'flac', br: 999000 }
}
