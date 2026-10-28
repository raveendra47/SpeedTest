module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/css": "css" });
  eleventyConfig.addPassthroughCopy({ "src/js": "js" });
  return {
    dir: { input: "src", output: "dist" },
    htmlTemplateEngine: "njk"
  };
};
