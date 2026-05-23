FROM golang:1.26-bookworm AS build

WORKDIR /src
COPY go.mod ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mirror .

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/mirror /usr/local/bin/mirror

EXPOSE 5100
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/mirror"]
