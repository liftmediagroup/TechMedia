import fs from "fs-extra"
import { GatsbyCache } from "gatsby"
import { fetchRemoteFile } from "gatsby-core-utils/fetch-remote-file"
import {
  Fit,
  IGatsbyImageData,
  IGatsbyImageHelperArgs,
  ImageFormat,
} from "gatsby-plugin-image"
import path from "path"

import {
  createUrl,
  isImage,
  mimeTypeExtensions,
  validImageFormats,
  CONTENTFUL_IMAGE_MAX_SIZE,
} from "./image-helpers"
import {
  contentfulImageApiBackgroundColor,
  IContentfulAsset,
  IContentfulImageAPITransformerOptions,
} from "./types/contentful"

// Promises that rejected should stay in this map. Otherwise remove promise and put their data in resolvedBase64Cache
const inFlightBase64Cache = new Map()
// This cache contains the resolved base64 fetches. This prevents async calls for promises that have resolved.
// The images are based on urls with w=20 and should be relatively small (<2kb) but it does stick around in memory
const resolvedBase64Cache = new Map()

// Note: this may return a Promise<body>, body (sync), or null
const getBase64Image = (
  imageProps: {
    image: IContentfulAsset
    baseUrl: string
    options: IContentfulImageAPITransformerOptions
    aspectRatio: number
  },
  cache: GatsbyCache
): string | null | Promise<string> => {
  if (!imageProps) {
    return null
  }

  // We only support images that are delivered through Contentful's Image API
  if (imageProps.baseUrl.indexOf(`images.ctfassets.net`) === -1) {
    return null
  }

  const placeholderWidth = imageProps.options.blurredOptions?.width || 20
  // Keep aspect ratio, image format and other transform options
  const { aspectRatio } = imageProps
  const originalFormat = imageProps.image.mimeType.split(`/`)[1]
  const toFormat =
    imageProps.options.blurredOptions?.toFormat || imageProps.options.toFormat

  const imageOptions = {
    ...imageProps.options,
    toFormat,
    width: placeholderWidth,
    height: Math.floor(placeholderWidth / aspectRatio),
  }

  const requestUrl = createUrl(imageProps.baseUrl, imageOptions)

  // Prefer to return data sync if we already have it
  const alreadyFetched = resolvedBase64Cache.get(requestUrl)
  if (alreadyFetched) {
    return alreadyFetched
  }

  // If already in flight for this url return the same promise as the first call
  const inFlight = inFlightBase64Cache.get(requestUrl)
  if (inFlight) {
    return inFlight
  }

  const loadImage = async (): Promise<string> => {
    const { mimeType } = imageProps.image

    const extension = mimeTypeExtensions.get(mimeType)

    const absolutePath = await fetchRemoteFile({
      url: requestUrl,
      directory: cache.directory,
      ext: extension,
      cacheKey: imageProps.image.internal.contentDigest,
    })

    const base64 = (await fs.readFile(absolutePath)).toString(`base64`)
    return `data:image/${toFormat || originalFormat};base64,${base64}`
  }

  const promise = loadImage()
  inFlightBase64Cache.set(requestUrl, promise)

  return promise.then(body => {
    inFlightBase64Cache.delete(requestUrl)
    resolvedBase64Cache.set(requestUrl, body)
    return body
  })
}

const getTracedSVG = async ({
  image,
  options,
  cache,
}: {
  image: IContentfulAsset
  options: IContentfulImageAPITransformerOptions
  cache: GatsbyCache
}): Promise<string | null> => {
  const { traceSVG } = await import(`gatsby-plugin-sharp`)
  const { url: imgUrl, filename, mimeType } = image

  if (mimeType.indexOf(`image/`) !== 0) {
    return null
  }

  const extension = mimeTypeExtensions.get(mimeType)
  const url = createUrl(imgUrl, options)
  const name = path.basename(filename, extension)

  const absolutePath = await fetchRemoteFile({
    url,
    name,
    directory: cache.directory,
    ext: extension,
    cacheKey: image.internal.contentDigest,
  })

  return traceSVG({
    file: {
      internal: image.internal,
      name: filename,
      extension,
      absolutePath,
    },
    args: { toFormat: ``, ...options.tracedSVGOptions },
    fileArgs: options,
  })
}

const getDominantColor = async ({
  image,
  options,
  cache,
}: {
  image: IContentfulAsset
  options: IContentfulImageAPITransformerOptions
  cache: GatsbyCache
}): Promise<string> => {
  let pluginSharp

  try {
    pluginSharp = await import(`gatsby-plugin-sharp`)
  } catch (e) {
    console.error(
      `[gatsby-source-contentful] Please install gatsby-plugin-sharp`,
      e
    )
    return `rgba(0,0,0,0.5)`
  }

  try {
    const { mimeType, url: imgUrl, filename } = image

    if (mimeType.indexOf(`image/`) !== 0) {
      return `rgba(0,0,0,0.5)`
    }

    // 256px should be enough to properly detect the dominant color
    if (!options.width) {
      options.width = 256
    }

    const extension = mimeTypeExtensions.get(mimeType)
    const url = createUrl(imgUrl, options)
    const name = path.basename(filename, extension)

    const absolutePath = await fetchRemoteFile({
      url,
      name,
      directory: cache.directory,
      ext: extension,
      cacheKey: image.internal.contentDigest,
    })

    if (!(`getDominantColor` in pluginSharp)) {
      console.error(
        `[gatsby-source-contentful] Please upgrade gatsby-plugin-sharp`
      )
      return `rgba(0,0,0,0.5)`
    }

    return pluginSharp.getDominantColor(absolutePath)
  } catch (e) {
    console.error(
      `[gatsby-source-contentful] Could not getDominantColor from image`,
      e
    )
    console.error(e)
    return `rgba(0,0,0,0.5)`
  }
}

function getBasicImageProps(
  image,
  args
): {
  baseUrl: string
  mimeType: string
  aspectRatio: number
  height: number
  width: number
} {
  let { width, height } = image
  if (args.width && args.height) {
    width = args.width
    height = args.height
  }

  return {
    baseUrl: image.url,
    mimeType: image.mimeType,
    aspectRatio: width / height,
    width,
    height,
  }
}

// Generate image source data for gatsby-plugin-image
export function generateImageSource(
  filename: string,
  width: number,
  height: number,
  toFormat: "gif" | ImageFormat,
  imageTransformOptions: IContentfulImageAPITransformerOptions
): { width: number; height: number; format: string; src: string } | undefined {
  const imageFormatDefaults = imageTransformOptions[`${toFormat}Options`]

  if (
    imageFormatDefaults &&
    Object.keys(imageFormatDefaults).length !== 0 &&
    imageFormatDefaults.constructor === Object
  ) {
    imageTransformOptions = {
      ...imageTransformOptions,
      ...imageFormatDefaults,
    }
  }

  const {
    jpegProgressive,
    quality,
    cropFocus,
    backgroundColor,
    resizingBehavior,
    cornerRadius,
  } = imageTransformOptions
  // Ensure we stay within Contentfuls Image API limits
  if (width > CONTENTFUL_IMAGE_MAX_SIZE) {
    height = Math.floor((height / width) * CONTENTFUL_IMAGE_MAX_SIZE)
    width = CONTENTFUL_IMAGE_MAX_SIZE
  }

  if (height > CONTENTFUL_IMAGE_MAX_SIZE) {
    width = Math.floor((width / height) * CONTENTFUL_IMAGE_MAX_SIZE)
    height = CONTENTFUL_IMAGE_MAX_SIZE
  }

  if (toFormat && !validImageFormats.has(toFormat)) {
    console.warn(
      `[gatsby-source-contentful] Invalid image format "${toFormat}". Supported types are jpg, png, webp and avif"`
    )
    return undefined
  }

  const src = createUrl(filename, {
    width,
    height,
    toFormat,
    resizingBehavior,
    background: backgroundColor?.replace(
      `#`,
      `rgb:`
    ) as contentfulImageApiBackgroundColor,
    quality,
    jpegProgressive,
    cropFocus,
    cornerRadius,
  })
  return { width, height, format: toFormat, src }
}

export async function resolveGatsbyImageData(
  image: IContentfulAsset,
  options: IContentfulImageAPITransformerOptions,
  // _context: any,
  // _info: GraphQLResolveInfo,
  { cache }: { cache: GatsbyCache }
): Promise<IGatsbyImageData | null> {
  if (!isImage(image)) return null

  const { generateImageData } = await import(`gatsby-plugin-image`)

  const { getPluginOptions, doMergeDefaults } = await import(
    `gatsby-plugin-sharp/plugin-options`
  )

  const sharpOptions = getPluginOptions()

  const userDefaults = sharpOptions.defaults

  const defaults = {
    tracedSVGOptions: {},
    blurredOptions: {},
    jpgOptions: {},
    pngOptions: {},
    webpOptions: {},
    gifOptions: {},
    avifOptions: {},
    quality: 50,
    placeholder: `dominantColor`,
    ...userDefaults,
  }

  options = doMergeDefaults(options, defaults)

  const { baseUrl, mimeType, width, height, aspectRatio } = getBasicImageProps(
    image,
    options
  )
  let [, fileFormat] = mimeType.split(`/`)
  if (fileFormat === `jpeg`) {
    fileFormat = `jpg`
  }

  const format: ImageFormat = fileFormat as ImageFormat

  // Translate Contentful resize parameter to gatsby-plugin-image css object fit
  const fitMap: Map<string | undefined, Fit> = new Map([
    [`pad`, `contain`],
    [`fill`, `cover`],
    [`scale`, `fill`],
    [`crop`, `cover`],
    [`thumb`, `cover`],
  ])

  const imageProps = generateImageData({
    ...options,
    pluginName: `gatsby-source-contentful`,
    sourceMetadata: { width, height, format },
    filename: baseUrl,
    generateImageSource:
      generateImageSource as unknown as IGatsbyImageHelperArgs["generateImageSource"],
    fit: fitMap.get(options.resizingBehavior),
    options: options as unknown as Record<string, unknown>,
  })

  let placeholderDataURI: string | null = null

  if (options.placeholder === `dominantColor`) {
    imageProps.backgroundColor = await getDominantColor({
      image,
      options,
      cache,
    })
  }

  if (options.placeholder === `blurred`) {
    placeholderDataURI = await getBase64Image(
      {
        baseUrl,
        image,
        options,
        aspectRatio,
      },
      cache
    )
  }

  if (options.placeholder === `tracedSVG`) {
    placeholderDataURI = await getTracedSVG({
      image,
      options,
      cache,
    })
  }

  if (placeholderDataURI) {
    imageProps.placeholder = { fallback: placeholderDataURI }
  }

  return imageProps
}
