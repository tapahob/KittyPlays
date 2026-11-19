#include <libyuv/convert_argb.h>
#include <libyuv/convert_from_argb.h>
#include <boost/beast/websocket.hpp>
#include <boost/beast/core.hpp>
#include <boost/asio.hpp>
#include <vulkan/vulkan.h>
#include <FidelityFX/host/backends/vk/ffx_vk.h>
#include <FidelityFX/host/ffx_opticalflow.h>
#include <FidelityFX/host/ffx_frameinterpolation.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
using tcp = asio::ip::tcp;
using Socket = websocket::stream<tcp::socket>;

constexpr size_t headerBytes = 9;
constexpr size_t maxMessage = 1920 * 1080 * 4 + headerBytes;
constexpr unsigned amdVendor = 0x1002;

#define CHECK(call) do { const auto status = (call); if (status != 0) \
    throw std::runtime_error(std::string(#call) + ": " + std::to_string(status)); } while (0)

#ifndef _WIN32
// The Linux SDK backend omits the presentation swapchain.
FFX_API FfxErrorCode ffxSetFrameGenerationConfigToSwapchainVK(const FfxFrameGenerationConfig*) {
    std::abort();
}
#endif

struct FramePacket {
    uint32_t width, height;
    bool reset;
    uint8_t colors, format;
    float milliseconds;
    const uint8_t* pixels;
};

FramePacket readPacket(const beast::flat_buffer& message) {
    if (message.size() < headerBytes) throw std::runtime_error("Incomplete frame header");
    const auto* data = static_cast<const uint8_t*>(message.data().data());
    const auto read16 = [data](size_t offset) { return uint32_t(data[offset]) | uint32_t(data[offset + 1]) << 8; };
    const FramePacket frame{read16(0), read16(2), data[4] != 0, data[5], data[6], read16(7) / 100.f, data + headerBytes};
    if (frame.width < 2 || frame.width > 1920 || frame.height < 2 || frame.height > 1080 ||
        ((frame.width | frame.height) & 1) || frame.colors > 3 || frame.format > 2 ||
        frame.milliseconds < 1 || frame.milliseconds > 500)
        throw std::runtime_error("Invalid frame format");
    const size_t pixels = size_t(frame.width) * frame.height;
    const size_t payload = frame.format == 2 ? pixels * 4 : pixels * 3 / 2;
    if (message.size() != headerBytes + payload) throw std::runtime_error("Invalid frame size");
    return frame;
}

bool readFrame(Socket& socket, beast::flat_buffer& message) {
    beast::error_code error;
    socket.read(message, error);
    if (error == websocket::error::closed || error == asio::error::eof || error == asio::error::connection_reset)
        return false;
    if (error) throw beast::system_error(error);
    if (!socket.got_binary()) throw std::runtime_error("Expected a binary video frame");
    return true;
}

struct Image {
    VkImage image;
    VkDeviceMemory memory;
    FfxResource resource;
};

void renderFrames(Socket& socket, beast::flat_buffer& message, uint32_t width, uint32_t height) {
    const size_t pixels = size_t(width) * height;
    const size_t bytes = pixels * 4;
    const FfxDimensions2D size{width, height};

    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "KittyPlays FidelityFX";
    app.apiVersion = VK_API_VERSION_1_3;
    VkInstanceCreateInfo instanceInfo{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    instanceInfo.pApplicationInfo = &app;
    VkInstance instance;
    CHECK(vkCreateInstance(&instanceInfo, nullptr, &instance));
    uint32_t count = 0;
    CHECK(vkEnumeratePhysicalDevices(instance, &count, nullptr));
    std::vector<VkPhysicalDevice> physicals(count);
    CHECK(vkEnumeratePhysicalDevices(instance, &count, physicals.data()));
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    for (auto candidate : physicals) {
        VkPhysicalDeviceProperties properties;
        vkGetPhysicalDeviceProperties(candidate, &properties);
        if (properties.vendorID != amdVendor || properties.apiVersion < VK_API_VERSION_1_3) continue;
        physical = candidate;
        if (properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) break;
    }
    if (!physical) throw std::runtime_error("FidelityFX requires an AMD Vulkan 1.3 adapter");
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, nullptr);
    std::vector<VkQueueFamilyProperties> families(count);
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, families.data());
    uint32_t family = 0;
    for (; family < count; ++family)
        if ((families[family].queueFlags & (VK_QUEUE_COMPUTE_BIT|VK_QUEUE_GRAPHICS_BIT)) ==
            (VK_QUEUE_COMPUTE_BIT|VK_QUEUE_GRAPHICS_BIT)) break;
    if (family == count) throw std::runtime_error("AMD graphics queue unavailable");
    VkPhysicalDeviceVulkan13Features v13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceVulkan12Features v12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, &v13};
    VkPhysicalDeviceFeatures2 features{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, &v12};
    vkGetPhysicalDeviceFeatures2(physical, &features);
    float priority = 1.f;
    VkDeviceQueueCreateInfo queueInfo{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queueInfo.queueFamilyIndex = family;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;
    VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, &features};
    deviceInfo.queueCreateInfoCount = 1;
    deviceInfo.pQueueCreateInfos = &queueInfo;
    VkDevice device;
    CHECK(vkCreateDevice(physical, &deviceInfo, nullptr, &device));
    VkQueue queue;
    vkGetDeviceQueue(device, family, 0, &queue);

    VkPhysicalDeviceMemoryProperties memProps;
    vkGetPhysicalDeviceMemoryProperties(physical, &memProps);
    auto allocate = [&](VkMemoryRequirements req, VkMemoryPropertyFlags flags) {
        for (uint32_t i = 0; i < memProps.memoryTypeCount; ++i) {
            if ((req.memoryTypeBits & (1u << i)) &&
                (memProps.memoryTypes[i].propertyFlags & flags) == flags) {
                VkMemoryAllocateInfo info{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
                info.allocationSize = req.size;
                info.memoryTypeIndex = i;
                VkDeviceMemory mem;
                CHECK(vkAllocateMemory(device, &info, nullptr, &mem));
                return mem;
            }
        }
        throw std::runtime_error("Required Vulkan memory type unavailable");
    };
    VkBufferCreateInfo bufferInfo{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    bufferInfo.size = bytes;
    bufferInfo.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    VkBuffer staging;
    CHECK(vkCreateBuffer(device, &bufferInfo, nullptr, &staging));
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, staging, &req);
    VkDeviceMemory stagingMemory = allocate(req, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    CHECK(vkBindBufferMemory(device, staging, stagingMemory, 0));
    void* mapped;
    CHECK(vkMapMemory(device, stagingMemory, 0, bytes, 0, &mapped));


    VkBuffer readback;
    bufferInfo.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    CHECK(vkCreateBuffer(device, &bufferInfo, nullptr, &readback));
    vkGetBufferMemoryRequirements(device, readback, &req);
    auto readbackMemory = allocate(req, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT);
    CHECK(vkBindBufferMemory(device, readback, readbackMemory, 0));
    void* result;
    CHECK(vkMapMemory(device, readbackMemory, 0, bytes, 0, &result));

    const size_t planarBytes = size_t(width) * height * 3 / 2;
    std::vector<uint8_t> planar(planarBytes);
    std::vector<uint8_t> converted(bytes);
    const libyuv::YuvConstants* matrices[] = {&libyuv::kYvuH709Constants, &libyuv::kYvuI601Constants, &libyuv::kYvuF709Constants, &libyuv::kYvuJPEGConstants};
    std::vector<Image> images;
    auto image = [&](VkFormat format, uint32_t w, uint32_t h, FfxResourceStates state, const wchar_t* name) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
        info.imageType = VK_IMAGE_TYPE_2D;
        info.format = format;
        info.extent = {w,h,1};
        info.mipLevels = info.arrayLayers = 1;
        info.samples = VK_SAMPLE_COUNT_1_BIT;
        info.tiling = VK_IMAGE_TILING_OPTIMAL;
        info.usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
        if (state == FFX_RESOURCE_STATE_UNORDERED_ACCESS) info.usage |= VK_IMAGE_USAGE_STORAGE_BIT;
        Image result{};
        CHECK(vkCreateImage(device, &info, nullptr, &result.image));
        vkGetImageMemoryRequirements(device, result.image, &req);
        result.memory = allocate(req, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        CHECK(vkBindImageMemory(device, result.image, result.memory, 0));
        result.resource = ffxGetResourceVK(result.image, ffxGetImageResourceDescriptionVK(result.image, info), name, state);
        images.push_back(result);
        return result;
    };

    VkCommandPoolCreateInfo poolInfo{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    poolInfo.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    poolInfo.queueFamilyIndex = family;
    VkCommandPool pool;
    CHECK(vkCreateCommandPool(device, &poolInfo, nullptr, &pool));
    VkCommandBufferAllocateInfo cmdInfo{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    cmdInfo.commandPool = pool;
    cmdInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cmdInfo.commandBufferCount = 1;
    VkCommandBuffer cmd;
    CHECK(vkAllocateCommandBuffers(device, &cmdInfo, &cmd));
    VkFenceCreateInfo fenceInfo{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    VkFence fence;
    CHECK(vkCreateFence(device, &fenceInfo, nullptr, &fence));
    auto begin = [&] {
        CHECK(vkResetCommandBuffer(cmd, 0));
        VkCommandBufferBeginInfo info{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
        info.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        CHECK(vkBeginCommandBuffer(cmd, &info));
    };
    auto submit = [&] {
        CHECK(vkEndCommandBuffer(cmd));
        CHECK(vkResetFences(device, 1, &fence));
        VkSubmitInfo info{VK_STRUCTURE_TYPE_SUBMIT_INFO};
        info.commandBufferCount = 1;
        info.pCommandBuffers = &cmd;
        CHECK(vkQueueSubmit(queue, 1, &info, fence));
        CHECK(vkWaitForFences(device, 1, &fence, VK_TRUE, 30000000000ull));
    };
    auto transition = [&](Image img, VkImageLayout oldLayout, VkImageLayout newLayout,
                          VkAccessFlags src, VkAccessFlags dst,
                          VkPipelineStageFlags srcStage, VkPipelineStageFlags dstStage) {
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        barrier.srcAccessMask = src;
        barrier.dstAccessMask = dst;
        barrier.oldLayout = oldLayout;
        barrier.newLayout = newLayout;
        barrier.srcQueueFamilyIndex = barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = img.image;
        barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        vkCmdPipelineBarrier(cmd, srcStage, dstStage, 0, 0, nullptr, 0, nullptr, 1, &barrier);
    };

    VkDeviceContext vkContext{device, physical, vkGetDeviceProcAddr, vkGetInstanceProcAddr, instance};
    const size_t scratchSize = ffxGetScratchMemorySizeVK(physical, 2);
    auto scratch = std::make_unique<unsigned char[]>(scratchSize);
    FfxInterface backend{};
    CHECK(ffxGetInterfaceVK(&backend, ffxGetDeviceVK(&vkContext), scratch.get(), scratchSize, 2));

    auto of = std::make_unique<FfxOpticalflowContext>();
    auto fi = std::make_unique<FfxFrameInterpolationContext>();
    FfxOpticalflowContextDescription ofInfo{backend, 0, size};
    CHECK(ffxOpticalflowContextCreate(of.get(), &ofInfo));
    FfxFrameInterpolationContextDescription fiInfo{};
    fiInfo.maxRenderSize = fiInfo.displaySize = size;
    fiInfo.backBufferFormat = fiInfo.previousInterpolationSourceFormat = FFX_SURFACE_FORMAT_R8G8B8A8_UNORM;
    fiInfo.backendInterface = backend;
    CHECK(ffxFrameInterpolationContextCreate(fi.get(), &fiInfo));
    FfxOpticalflowSharedResourceDescriptions ofShared{};
    FfxFrameInterpolationSharedResourceDescriptions fiShared{};
    CHECK(ffxOpticalflowGetSharedResourceDescriptions(of.get(), &ofShared));
    CHECK(ffxFrameInterpolationGetSharedResourceDescriptions(fi.get(), &fiShared));
    constexpr auto read = FFX_RESOURCE_STATE_COMPUTE_READ;
    constexpr auto write = FFX_RESOURCE_STATE_UNORDERED_ACCESS;
    const auto color = image(VK_FORMAT_R8G8B8A8_UNORM, width, height, read, L"Input color");
    const auto depth = image(VK_FORMAT_R32_SFLOAT, width, height, read, L"Constant depth");
    const auto motion = image(VK_FORMAT_R16G16_SFLOAT, width, height, read, L"Zero game MV");
    const auto output = image(VK_FORMAT_R8G8B8A8_UNORM, width, height, write, L"Generated frame");
    auto shared = [&](const FfxCreateResourceDescription& desc, VkFormat format) {
        return image(format, desc.resourceDescription.width, desc.resourceDescription.height, write, desc.name);
    };
    const auto flow = shared(ofShared.opticalFlowVector, VK_FORMAT_R16G16_SINT);
    const auto scd = shared(ofShared.opticalFlowSCD, VK_FORMAT_R32_UINT);
    const auto dilatedDepth = shared(fiShared.dilatedDepth, VK_FORMAT_R32_SFLOAT);
    const auto dilatedMotion = shared(fiShared.dilatedMotionVectors, VK_FORMAT_R16G16_SFLOAT);
    const auto prevDepth = shared(fiShared.reconstructedPrevNearestDepth, VK_FORMAT_R32_UINT);

    const VkImageSubresourceRange colorRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    begin();
    for (auto img : images) {
        transition(img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                   0, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);
        VkClearColorValue value{};
        if (img.image == depth.image) value.float32[0] = 0.5f;
        vkCmdClearColorImage(cmd, img.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &value, 1, &colorRange);
        transition(img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                   img.resource.state == read ? VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL : VK_IMAGE_LAYOUT_GENERAL,
                   VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                   VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT);
    }
    submit();

    const auto list = ffxGetCommandListVK(cmd);
    constexpr auto srgb = FFX_BACKBUFFER_TRANSFER_FUNCTION_SRGB;
    FfxFrameInterpolationPrepareDescription prep{};
    prep.commandList = list;
    prep.renderSize = size;
    prep.motionVectorScale = {float(width), float(height)};
    prep.cameraNear = 0.1f;
    prep.cameraFar = 100.f;
    prep.cameraFovAngleVertical = 1.f;
    prep.viewSpaceToMetersFactor = 1.f;
    prep.depth = depth.resource;
    prep.motionVectors = motion.resource;
    prep.dilatedDepth = dilatedDepth.resource;
    prep.dilatedMotionVectors = dilatedMotion.resource;
    prep.reconstructedPrevDepth = prevDepth.resource;
    prep.cameraUp[1] = prep.cameraRight[0] = prep.cameraForward[2] = 1.f;

    FfxOpticalflowDispatchDescription optical{list, color.resource, flow.resource, scd.resource, false, srgb, {0.f, 1.f}};
    FfxFrameInterpolationDispatchDescription interpolate{};
    interpolate.commandList = list;
    interpolate.displaySize = interpolate.renderSize = size;
    interpolate.currentBackBuffer = color.resource;
    interpolate.output = output.resource;
    interpolate.interpolationRect = {0, 0, int(width), int(height)};
    interpolate.opticalFlowVector = flow.resource;
    interpolate.opticalFlowSceneChangeDetection = scd.resource;
    interpolate.opticalFlowBufferSize = {flow.resource.description.width, flow.resource.description.height};
    interpolate.opticalFlowScale = {1.f/width, 1.f/height};
    interpolate.opticalFlowBlockSize = 8;
    interpolate.cameraNear = prep.cameraNear;
    interpolate.cameraFar = prep.cameraFar;
    interpolate.cameraFovAngleVertical = prep.cameraFovAngleVertical;
    interpolate.viewSpaceToMetersFactor = prep.viewSpaceToMetersFactor;
    interpolate.backBufferTransferFunction = srgb;
    interpolate.minMaxLuminance[1] = 1.f;
    interpolate.dilatedDepth = prep.dilatedDepth;
    interpolate.dilatedMotionVectors = prep.dilatedMotionVectors;
    interpolate.reconstructedPrevDepth = prep.reconstructedPrevDepth;

    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent = {width, height, 1};
    uint64_t frameId = 0;
    do {
        const auto packet = readPacket(message);
        if (packet.width != width || packet.height != height) break;
        const auto* chroma = packet.pixels + pixels;
        if (packet.format == 0) {
            CHECK(libyuv::NV21ToARGBMatrix(packet.pixels, width, chroma, width, converted.data(),
                width * 4, matrices[packet.colors], width, height));
        } else if (packet.format == 1) {
            CHECK(libyuv::I420ToARGBMatrix(packet.pixels, width, chroma + pixels / 4, width / 2,
                chroma, width / 2, converted.data(), width * 4, matrices[packet.colors], width, height));
        }
        std::memcpy(mapped, packet.format == 2 ? packet.pixels : converted.data(), bytes);
        message.consume(message.size());
        begin();
        transition(color, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                   VK_ACCESS_SHADER_READ_BIT, VK_ACCESS_TRANSFER_WRITE_BIT,
                   VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);
        vkCmdCopyBufferToImage(cmd, staging, color.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
        transition(color, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                   VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
                   VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT);
        prep.frameID = interpolate.frameID = frameId;
        optical.reset = interpolate.reset = frameId++ == 0 || packet.reset;
        prep.frameTimeDelta = interpolate.frameTimeDelta = packet.milliseconds;
        CHECK(ffxFrameInterpolationPrepare(fi.get(), &prep));
        CHECK(ffxOpticalflowContextDispatch(of.get(), &optical));
        CHECK(ffxFrameInterpolationDispatch(fi.get(), &interpolate));
        transition(output, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                   VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT,
                   VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);
        vkCmdCopyImageToBuffer(cmd, output.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback, 1, &region);
        transition(output, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL,
                   VK_ACCESS_TRANSFER_READ_BIT, VK_ACCESS_SHADER_WRITE_BIT,
                   VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT);
        submit();


        CHECK(libyuv::ABGRToNV12(static_cast<const uint8_t*>(result), width * 4,
            planar.data(), width, planar.data() + pixels, width, width, height));
        socket.write(asio::buffer(planar));
    } while (readFrame(socket, message));

    CHECK(ffxFrameInterpolationContextDestroy(fi.get()));
    CHECK(ffxOpticalflowContextDestroy(of.get()));
    vkDestroyFence(device, fence, nullptr);
    vkDestroyCommandPool(device, pool, nullptr);
    for (auto img : images) {
        vkDestroyImage(device, img.image, nullptr);
        vkFreeMemory(device, img.memory, nullptr);
    }
    vkUnmapMemory(device, stagingMemory);
    vkDestroyBuffer(device, staging, nullptr);
    vkFreeMemory(device, stagingMemory, nullptr);
    vkUnmapMemory(device, readbackMemory);
    vkDestroyBuffer(device, readback, nullptr);
    vkFreeMemory(device, readbackMemory, nullptr);
    vkDestroyDevice(device, nullptr);
    vkDestroyInstance(instance, nullptr);
}

void nativeMessage(const std::string& body) {
    const uint32_t size = static_cast<uint32_t>(body.size());
    const unsigned char header[]{static_cast<unsigned char>(size), static_cast<unsigned char>(size >> 8),
        static_cast<unsigned char>(size >> 16), static_cast<unsigned char>(size >> 24)};
    std::fwrite(header, 1, sizeof(header), stdout);
    std::fwrite(body.data(), 1, body.size(), stdout);
    std::fflush(stdout);
}

int main() {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::thread([] {
        while (std::getchar() != EOF) {}
        std::quick_exit(0);
    }).detach();
    try {
        std::random_device random;
        const char hex[] = "0123456789abcdef";
        std::string token(64, '0');
        for (auto& digit : token) digit = hex[random() & 15];

        asio::io_context io;
        tcp::acceptor listener(io, {asio::ip::address_v4::loopback(), 0});
        nativeMessage("{\"port\":" + std::to_string(listener.local_endpoint().port()) +
            ",\"token\":\"" + token + "\",\"version\":1}");

        auto connection = listener.accept();
        connection.set_option(tcp::no_delay(true));
        beast::flat_buffer handshakeBuffer(8192);
        http::request_parser<http::empty_body> request;
        request.header_limit(8192);
        http::read_header(connection, handshakeBuffer, request);
        if (request.get()[http::field::origin] != "https://www.youtube.com")
            throw std::runtime_error("Unexpected WebSocket origin");

        Socket socket(std::move(connection));
        socket.read_message_max(token.size());
        socket.accept(request.get());
        beast::flat_buffer auth(token.size());
        socket.read(auth);
        if (!socket.got_text() || beast::buffers_to_string(auth.data()) != token)
            throw std::runtime_error("Invalid session token");

        socket.read_message_max(maxMessage);
        socket.text(true);
        socket.write(asio::buffer("ready", 5));
        socket.binary(true);
        socket.auto_fragment(false);
        beast::flat_buffer message(maxMessage);
        if (readFrame(socket, message)) {
            do {
                const auto frame = readPacket(message);
                renderFrames(socket, message, frame.width, frame.height);
            } while (message.size());
        }
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "KittyPlays FidelityFX: %s\n", error.what());
        return 1;
    }
}
