// HelloPCF — minimal PCF control for HMR testing
// Change "v1" to "v2" (or anything) and save to test hot-reload.
(function () {
  var VERSION = "v1";

  function HelloPCF() {}

  HelloPCF.prototype.init = function (context, notifyOutputChanged, state, container) {
    this._container = container;
    this._render();
  };

  HelloPCF.prototype.updateView = function (context) {
    this._render();
  };

  HelloPCF.prototype._render = function () {
    if (!this._container) return;
    this._container.innerHTML =
      '<div style="padding:2rem;font-family:system-ui;background:#e0f0ff;border-radius:8px;text-align:center">' +
      '<h1>Hello from PCF! (' + VERSION + ')</h1>' +
      '<p>Edit <code>bundle.js</code> and change VERSION to see HMR in action.</p>' +
      '</div>';
  };

  HelloPCF.prototype.destroy = function () {
    if (this._container) this._container.innerHTML = "";
  };

  HelloPCF.prototype.getOutputs = function () {
    return {};
  };

  // Register with ComponentFramework (mocked in test-page.html, real in Dataverse)
  if (window.ComponentFramework && window.ComponentFramework.registerControl) {
    window.ComponentFramework.registerControl("Example.HelloPCF", HelloPCF);
  }

  // Auto-init into #pcf-root so reloaded scripts produce visible changes
  var root = document.getElementById("pcf-root");
  if (root) {
    var instance = new HelloPCF();
    instance.init({}, function () {}, null, root);
  }
})();
