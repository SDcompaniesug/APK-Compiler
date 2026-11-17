FROM eclipse-temurin:17-jdk-jammy
ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/android-sdk/platform-tools:/opt/android-sdk/cmdline-tools/latest/bin:/opt/flutter/bin:/opt/java/openjdk/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip zip git python3 ca-certificates file libc6 libstdc++6 lib32z1 lib32stdc++6 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/android-sdk/cmdline-tools /tmp/android-tools && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip && unzip -q /tmp/cmdline-tools.zip -d /tmp/android-tools && mv /tmp/android-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest && rm -rf /tmp/android-tools /tmp/cmdline-tools.zip
RUN yes | sdkmanager --sdk_root=${ANDROID_HOME} --licenses >/dev/null && sdkmanager --sdk_root=${ANDROID_HOME} "platform-tools" "platforms;android-33" "platforms;android-34" "platforms;android-35" "platforms;android-36" "build-tools;33.0.2" "build-tools;34.0.0" "build-tools;35.0.0" "build-tools;36.0.0" "build-tools;28.0.3" "ndk;28.2.13676358"
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin builder && chown root:root /home/builder && chmod 755 /home/builder
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chown -R root:root /app && chmod -R a+rX /app
USER root
ENV NODE_ENV=production
CMD ["node","worker.js"]
