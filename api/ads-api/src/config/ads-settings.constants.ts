/**
 * CrimFig Ads Platform — Media Upload Restrictions & Storage Settings
 * 
 * Design Pattern:
 * Centralized settings constant to ensure single source of truth across
 * uploads validation, controllers, and future migration to database settings / dynamic fallbacks.
 */

export interface AdsMediaUploadSettings {
  limits: {
    /** Maximum image file size in bytes: 750 KB */
    imageMaxBytes: number;
    /** Maximum video file size in bytes: 20 MB */
    videoMaxBytes: number;
  };
  allowedMimes: {
    images: string[];
    videos: string[];
  };
  /**
   * Browser compatibility matrix for media formats
   * Allows frontend to warn advertisers about partial browser support or recommend optimal alternatives
   */
  formatCompatibility: Record<
    string,
    {
      label: string;
      support: 'full' | 'partial' | 'poor';
      warning?: string;
      isAnimatedOnlyAsVideo?: boolean;
    }
  >;
  storage: {
    provider: 'firebase';
    /** No subfolders in bucket. Flat key naming with prefixes like "photo-" or "file-" */
    imagePrefix: string;
    videoPrefix: string;
    filePrefix: string;
    /** URL signature expiration in minutes for signed direct actions */
    signedUrlTtlMinutes: number;
    /** All files are private and only accessible via server stream/proxy */
    isPrivate: boolean;
  };
  processing: {
    /** Do NOT compress or optimize on server. Reject outright if exceeding limits. */
    serverOptimizationEnabled: boolean;
  };
}

export const ADS_MEDIA_UPLOAD_SETTINGS: AdsMediaUploadSettings = {
  limits: {
    imageMaxBytes: 750 * 1024, // 750 KB
    videoMaxBytes: 20 * 1024 * 1024, // 20 MB
  },
  allowedMimes: {
    images: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/gif', // Static GIFs only for photo slots; animated GIFs reclassified to video
    ],
    videos: [
      'video/mp4',
      'video/webm',
    ],
  },
  formatCompatibility: {
    'image/jpeg': {
      label: 'JPEG / JPG',
      support: 'full',
    },
    'image/png': {
      label: 'PNG',
      support: 'full',
    },
    'image/webp': {
      label: 'WebP',
      support: 'full',
    },
    'image/avif': {
      label: 'AVIF',
      support: 'full', // Modern Chrome, Safari, Firefox, Edge support AVIF
    },
    'image/gif': {
      label: 'GIF',
      support: 'full',
      isAnimatedOnlyAsVideo: true,
      warning: 'Animated GIFs are classified as videos (max 20MB). Only static single-frame GIFs are accepted as photo creatives.',
    },
    'video/mp4': {
      label: 'MP4 (H.264)',
      support: 'full',
    },
    'video/webm': {
      label: 'WebM (VP9/AV1)',
      support: 'partial',
      warning: 'WebM may have limited hardware acceleration on older iOS/Safari browsers; MP4 is recommended for universal reach.',
    },
  },
  storage: {
    provider: 'firebase',
    imagePrefix: 'photo-',
    videoPrefix: 'file-',
    filePrefix: 'file-',
    signedUrlTtlMinutes: 15,
    isPrivate: true,
  },
  processing: {
    serverOptimizationEnabled: false,
  },
};
