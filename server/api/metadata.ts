import type { TvShowProvider } from '@server/api/provider';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import Tvdb from '@server/api/tvdb';
import { getSettings, MetadataProviderType } from '@server/lib/settings';
import logger from '@server/logger';

export const getMetadataProvider = async (
  mediaType: 'movie' | 'tv' | 'anime'
): Promise<TvShowProvider> => {
  try {
    const settings = await getSettings();

    if (mediaType == 'movie') {
      return new TheMovieDb();
    }

    if (
      mediaType == 'tv' &&
      settings.metadataSettings.tv == MetadataProviderType.TVDB
    ) {
      return await Tvdb.getInstance();
    }

    if (
      mediaType == 'anime' &&
      settings.metadataSettings.anime == MetadataProviderType.TVDB
    ) {
      return await Tvdb.getInstance();
    }

    return new TheMovieDb();
  } catch (e) {
    logger.error('Failed to get metadata provider', {
      label: 'Metadata',
      message: e.message,
    });
    return new TheMovieDb();
  }
};

/**
 * Resolves the provider for a series, which depends on whether TMDB tags it as
 * anime. Reading that keyword costs a full show fetch, so it is only done when
 * the `tv` and `anime` providers actually differ; otherwise both branches
 * resolve to the same provider and the fetch cannot change the outcome.
 */
export const getTvShowMetadataProvider = async (
  tvId: number
): Promise<TvShowProvider> => {
  const settings = getSettings();

  if (settings.metadataSettings.tv === settings.metadataSettings.anime) {
    return getMetadataProvider('tv');
  }

  const tmdbTv = await new TheMovieDb().getTvShow({ tvId });
  const isAnime = tmdbTv.keywords.results.some(
    (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
  );

  return getMetadataProvider(isAnime ? 'anime' : 'tv');
};
