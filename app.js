App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: "cloudbase-d5gi7lrk1ed819fe7",
        traceUser: true
      });
    }
  }
});
