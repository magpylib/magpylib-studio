/*
Keep each example's view in the docs' theme.

An example page shows the example's saved page in a frame, and a saved view
wears what it sits on: inside the frame, that is the frame's own page, which
never hears of the theme switch (pydata's light, dark and auto). So each
frame's page is painted the docs' own background, and painted again whenever
the switch changes it; the view watches what it sits on, and follows.
*/
(function () {
  "use strict";

  function background() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--pst-color-background")
      .trim();
  }

  function dress(frame) {
    var page = frame.contentDocument;
    if (!page || !page.body) return; // not loaded yet: its load event will
    var colour = background();
    var dark = document.documentElement.dataset.theme === "dark";
    page.documentElement.style.colorScheme = dark ? "dark" : "light";
    page.body.style.setProperty("background", colour, "important");
  }

  function frames() {
    return document.querySelectorAll("iframe.magpy-example");
  }

  function dressAll() {
    frames().forEach(dress);
  }

  document.addEventListener("DOMContentLoaded", function () {
    frames().forEach(function (frame) {
      frame.addEventListener("load", function () {
        dress(frame);
      });
      dress(frame);
    });
    // the switch sets data-theme on the root; auto follows the system
    new MutationObserver(dressAll).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-mode"],
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener(
      "change",
      dressAll,
    );
  });
})();
