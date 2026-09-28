FROM node:22-bookworm-slim AS browser
WORKDIR /build/browser
COPY browser/package*.json ./
RUN npm ci
COPY browser/ ./
RUN npm run build:bookmarklet

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /source
COPY src/CalendarBridge.Api/CalendarBridge.Api.csproj src/CalendarBridge.Api/
RUN dotnet restore src/CalendarBridge.Api/CalendarBridge.Api.csproj
COPY src/ src/
COPY --from=browser /build/src/CalendarBridge.Api/wwwroot/ src/CalendarBridge.Api/wwwroot/
RUN dotnet publish src/CalendarBridge.Api/CalendarBridge.Api.csproj -c Release -o /app --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app ./
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENV ASPNETCORE_ENVIRONMENT=Production CALENDAR_DB_PATH=/var/data/calendar.db PORT=10000
EXPOSE 10000
ENTRYPOINT ["/entrypoint.sh"]
