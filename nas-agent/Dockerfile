FROM alpine:latest

# Install dependencies for the bash client
RUN apk add --no-cache curl bash procps sed grep gawk iproute2 jq smartmontools

WORKDIR /app

# Copy the client script
COPY client.sh .
RUN chmod +x client.sh

# Run the client
CMD ["./client.sh"]
