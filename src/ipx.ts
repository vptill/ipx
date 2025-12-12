import { defu } from "defu";
import { hasProtocol, joinURL, withLeadingSlash } from "ufo";
import type { SharpOptions } from "sharp";
import { createError } from "h3";
import { imageMeta as getImageMeta, type ImageMeta } from "image-meta";
import type { Config as SVGOConfig } from "svgo";
import type { IPXStorage } from "./types";
import { HandlerName, applyHandler, getHandler } from "./handlers";
import { cachedPromise, getEnv } from "./utils";

type IPXSourceMeta = {
  /**
   * The modification time of the source. Used for cache validation.
   * @optional
   */
  mtime?: Date;

  /**
   * The maximum age (in seconds) that the source should be considered fresh.
   * @optional
   */
  maxAge?: number;
};

/**
 * A function type that defines an IPX image processing instance.
 *
 * This function takes an image identifier and optional modifiers and request options, then provides methods to retrieve
 * image metadata and process the image according to the specified modifiers.
 *
 * @param {string} id - The identifier for the image. This can be a URL or a path, depending on the storage implementation.
 * @param {partial<Record<HandlerName | "f" | "format" | "a" | "animated", string>>} [modifiers] - Modifiers to be applied to the image,
 * such as resizing, cropping or format conversion. This record contains predefined keys such as 'f' or 'format' to specify the output to
 * specify the output image format, and 'a' or 'animated' to specify whether the image should be processed as an animation. See
 * {@link HandlerName}.
 * @param {any} [requestOptions] - Additional options that may be needed for request handling, specific to the storage backend.
 * Returns an object with methods:
 * - `getSourceMeta`: A method that returns a promise resolving to the source image metadata (`IPXSourceMeta`).
 * - `process`: A method that returns a promise resolving to an object containing the processed image data, metadata,
 * and format. The image data can be in the form of a `buffer` or a string, depending on the format and processing.
 */
export type IPX = (
  id: string,
  modifiers?: Partial<
    Record<HandlerName | "f" | "format" | "a" | "animated" | "svgo", string>
  >,
  requestOptions?: any,
) => {
  getSourceMeta: () => Promise<IPXSourceMeta>;
  process: () => Promise<{
    data: Buffer | string;
    meta?: ImageMeta;
    format?: string;
  }>;
};

export type IPXOptions = {
  /**
   * Default cache duration in seconds. If not specified, a default of 1 minute is used.
   * @optional
   */
  maxAge?: number;

  /**
   * A mapping of URL aliases to their corresponding URLs, used to simplify resource identifiers.
   * @optional
   */
  alias?: Record<string, string>;

  /**
   * Configuration options for the Sharp image processing library.
   * @optional
   */
  sharpOptions?: SharpOptions;

  /**
   * Primary storage backend for handling image assets.
   */
  storage: IPXStorage;

  /**
   * An optional secondary storage backend used when images are fetched via HTTP.
   * @optional
   */
  httpStorage?: IPXStorage;

  /**
   * Configuration for the SVGO library used when processing SVG images.
   * @optional
   */
  svgo?: false | SVGOConfig;
};

// https://sharp.pixelplumbing.com/#formats
// (gif and svg are not supported as output)
const SUPPORTED_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "avif",
  "tiff",
  "heif",
  "gif",
  "heic",
]);

/**
 * Creates an IPX image processing instance with the specified options.
 * @param {IPXOptions} userOptions - Configuration options for the IPX instance. See {@link IPXOptions}.
 * @returns {IPX} An IPX processing function configured with the given options. See {@link IPX}.
 * @throws {Error} If critical options such as storage are missing or incorrectly configured.
 */
export function createIPX(userOptions: IPXOptions): IPX {
  const options: IPXOptions = defu(userOptions, {
    alias: getEnv<Record<string, string>>("IPX_ALIAS") || {},
    maxAge: getEnv<number>("IPX_MAX_AGE") ?? 60 /* 1 minute */,
    sharpOptions: <SharpOptions>{
      jpegProgressive: true,
    },
  } satisfies Omit<IPXOptions, "storage">);

  // Normalize alias to start with leading slash
  options.alias = Object.fromEntries(
    Object.entries(options.alias || {}).map((e) => [
      withLeadingSlash(e[0]),
      e[1],
    ]),
  );

  // Sharp loader
  const getSharp = cachedPromise(async () => {
    return (await import("sharp").then(
      (r) => r.default || r,
    )) as typeof import("sharp");
  });

  const getSVGO = cachedPromise(async () => {
    const { optimize } = await import("svgo");
    return { optimize };
  });

  return function ipx(id, modifiers = {}, opts = {}) {
    // Validate id
    if (!id) {
      throw createError({
        statusCode: 400,
        statusText: `IPX_MISSING_ID`,
        message: `Resource id is missing`,
      });
    }

    // Enforce leading slash for non absolute urls
    id = hasProtocol(id) ? id : withLeadingSlash(id);

    // Resolve alias
    for (const base in options.alias) {
      if (id.startsWith(base)) {
        id = joinURL(options.alias[base], id.slice(base.length));
      }
    }

    // Resolve Storage
    const storage = hasProtocol(id)
      ? options.httpStorage || options.storage
      : options.storage || options.httpStorage;
    if (!storage) {
      throw createError({
        statusCode: 500,
        statusText: `IPX_NO_STORAGE`,
        message: "No storage configured!",
      });
    }

    // Resolve Resource
    const getSourceMeta = cachedPromise(async () => {
      const sourceMeta = await storage.getMeta(id, opts);
      if (!sourceMeta) {
        throw createError({
          statusCode: 404,
          statusText: `IPX_RESOURCE_NOT_FOUND`,
          message: `Resource not found: ${id}`,
        });
      }
      const _maxAge = sourceMeta.maxAge ?? options.maxAge;
      return {
        maxAge:
          typeof _maxAge === "string" ? Number.parseInt(_maxAge) : _maxAge,
        mtime: sourceMeta.mtime ? new Date(sourceMeta.mtime) : undefined,
      } satisfies IPXSourceMeta;
    });
    const getSourceData = cachedPromise(async () => {
      const sourceData = await storage.getData(id, opts);
      if (!sourceData) {
        throw createError({
          statusCode: 404,
          statusText: `IPX_RESOURCE_NOT_FOUND`,
          message: `Resource not found: ${id}`,
        });
      }
      return Buffer.from(sourceData);
    });

    const process = cachedPromise(async () => {
      // const _sourceMeta = await getSourceMeta();
      const sourceData = await getSourceData();

      // Detect source image meta
      let imageMeta: ImageMeta;
      try {
        imageMeta = getImageMeta(sourceData) as ImageMeta;
      } catch {
        throw createError({
          statusCode: 400,
          statusText: `IPX_INVALID_IMAGE`,
          message: `Cannot parse image metadata: ${id}`,
        });
      }

      // Determine format
      let mFormat = modifiers.f || modifiers.format;
      if (mFormat === "jpg") {
        mFormat = "jpeg";
      }
      const format =
        mFormat && SUPPORTED_FORMATS.has(mFormat)
          ? mFormat
          : SUPPORTED_FORMATS.has(imageMeta.type || "") // eslint-disable-line unicorn/no-nested-ternary
            ? imageMeta.type
            : "jpeg";

      // Use original SVG if format is not specified
      if (imageMeta.type === "svg" && !mFormat) {
        if (options.svgo === false) {
          return {
            data: sourceData,
            format: "svg+xml",
            meta: imageMeta,
          };
        } else {
          // https://github.com/svg/svgo
          const { optimize } = await getSVGO();

          // Start with the static SVGO configuration
          let svgoConfig: SVGOConfig = options.svgo || {};

          // 💡 Dynamic SVGO Configuration based on URL Modifier (svgo=...)
          const svgoModifier = modifiers.svgo;

          if (svgoModifier) {
            let operation = svgoModifier.toString();
            let param = '';

            // Handle comma splitting by IPX core (e.g. svgo_convertColors,s_rgb_000000 -> svgo="convertColors", s="rgb_000000")
            if (operation === 'convertColors' && (modifiers as any).s) {
              param = `s_${(modifiers as any).s}`;
            } else if (operation.includes(',')) {
              const split = operation.split(',');
              operation = split[0];
              param = split[1];
            }

            if (operation === 'convertColors' && param) {
              let colorValue = '';

              // Extract color value from the second part (e.g., s_rgb_ffffff)
              if (param.startsWith('s_rgb_')) {
                colorValue = `#${param.slice(6)}`; // Converts s_rgb_ffffff to #ffffff
              } else if (param === 's_currentColor') {
                colorValue = 'currentColor';
              }

              if (colorValue) {
                // Create the dynamic plugins array
                const dynamicPlugins = [
                  // 1. Remove existing fill, stroke, and opacity attributes
                  {
                    name: 'removeAttrs',
                    params: {
                      // Remove fill, stroke, and opacity attributes to prep for recoloring
                      attrs: '(fill|stroke|fill-opacity|stroke-opacity|opacity)'
                    }
                  },
                  // 2. Set the desired fill color on the root SVG element
                  {
                    name: 'addAttributesToSVGElement',
                    params: {
                      attributes: [
                        { 'fill': colorValue }
                      ]
                    }
                  }
                ];

                // Merge dynamic plugins with static plugins
                svgoConfig = {
                  ...svgoConfig,
                  // Ensure 'removeScripts' is still run, usually handled by IPX core, but explicitly include
                  plugins: [
                    ...(dynamicPlugins as any), // Type assertion might be needed here
                    ...(options.svgo?.plugins || []) // Add any static plugins defined in ipx.js
                  ],
                };
              }
            }
          }

          // Apply a base cleanup/safety plugin (if not using preset-default)
          // IPX already adds 'removeScripts' implicitly, so we merge with the dynamically constructed config.
          const svg = optimize(sourceData.toString("utf8"), {
            ...svgoConfig,
            // Ensure removeScripts is the first plugin, as IPX seems to enforce it
            plugins: ["removeScripts", ...(svgoConfig?.plugins || [])],
          }).data;

          return {
            data: svg,
            format: "svg+xml",
            meta: imageMeta,
          };
        }
      }

      // Experimental animated support
      // https://github.com/lovell/sharp/issues/2275
      const animated =
        modifiers.animated !== undefined ||
        modifiers.a !== undefined ||
        format === "gif";

      const Sharp = await getSharp();
      let sharp = Sharp(sourceData, { animated, ...options.sharpOptions });
      Object.assign(
        (sharp as unknown as { options: SharpOptions }).options,
        options.sharpOptions,
      );

      // Resolve modifiers to handlers and sort
      const handlers = Object.entries(modifiers)
        .map(([name, arguments_]) => ({
          handler: getHandler(name as HandlerName),
          name,
          args: arguments_,
        }))
        .filter((h) => h.handler)
        .sort((a, b) => {
          const aKey = (a.handler.order || a.name || "").toString();
          const bKey = (b.handler.order || b.name || "").toString();
          return aKey.localeCompare(bKey);
        });

      // Apply handlers
      const handlerContext: any = { meta: imageMeta };
      for (const h of handlers) {
        sharp = applyHandler(handlerContext, sharp, h.handler, h.args) || sharp;
      }

      // Apply format
      if (SUPPORTED_FORMATS.has(format || "")) {
        sharp = sharp.toFormat(format as any, {
          quality: handlerContext.quality,
        });
      }

      // Convert to buffer
      const processedImage = await sharp.toBuffer();

      return {
        data: processedImage,
        format,
        meta: imageMeta,
      };
    });

    return {
      getSourceMeta,
      process,
    };
  };
}
