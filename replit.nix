{ pkgs }: {
  deps = [
    pkgs.nodejs-20_x
    pkgs.git
    pkgs.openssl
  ];

  env = {
    NODE_ENV = "production";
    NPM_CONFIG_LOGLEVEL = "warn";
  };
}
