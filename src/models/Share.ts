export interface ShareOptions {
  allowComments: boolean
  allowAsk: boolean
}

export interface Share {
  id: string
  token: string
  projectPath: string
  filePath: string
  snapshotPath: string
  createdAt: string
  expiresAt: string
  revokedAt?: string
  options: ShareOptions
  createdBy?: string
}

export interface ShareIndex {
  shares: Share[]
}

export const SHARE_TOKEN_BYTES = 24
