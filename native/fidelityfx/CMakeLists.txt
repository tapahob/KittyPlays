cmake_minimum_required(VERSION 3.20)
project(KittyPlaysFidelityFX LANGUAGES CXX)

set(FFX_SDK "" CACHE PATH "Path to the FidelityFX SDK's sdk directory")
set(FFX_VK_LIBRARY "" CACHE FILEPATH "Built FidelityFX Vulkan backend library")
if(NOT IS_DIRECTORY "${FFX_SDK}/include/FidelityFX" OR NOT EXISTS "${FFX_VK_LIBRARY}")
    message(FATAL_ERROR "Set FFX_SDK and FFX_VK_LIBRARY to a built FidelityFX SDK")
endif()

find_package(Vulkan REQUIRED)
find_package(Boost 1.75 REQUIRED)
find_package(Threads REQUIRED)
find_path(LIBYUV_INCLUDE_DIR libyuv/convert_argb.h REQUIRED)
find_library(LIBYUV_LIBRARY NAMES yuv libyuv REQUIRED)

add_executable(kittyplays-fidelityfx host.cpp)
target_compile_features(kittyplays-fidelityfx PRIVATE cxx_std_20)
target_include_directories(kittyplays-fidelityfx PRIVATE
    "${FFX_SDK}/include" "${FFX_SDK}/include/FidelityFX/host" "${LIBYUV_INCLUDE_DIR}")
if(WIN32)
    find_library(FFX_INTERPOLATION_LIBRARY NAMES ffx_frameinterpolation_x64
        PATHS "${FFX_SDK}/bin/ffx_sdk" REQUIRED)
    find_library(FFX_OPTICAL_FLOW_LIBRARY NAMES ffx_opticalflow_x64
        PATHS "${FFX_SDK}/bin/ffx_sdk" REQUIRED)
    target_compile_definitions(kittyplays-fidelityfx PRIVATE VK_USE_PLATFORM_WIN32_KHR NOMINMAX _WIN32_WINNT=0x0A00)
    target_link_libraries(kittyplays-fidelityfx PRIVATE
        "${FFX_INTERPOLATION_LIBRARY}" "${FFX_OPTICAL_FLOW_LIBRARY}" ws2_32 mswsock)
endif()
target_link_libraries(kittyplays-fidelityfx PRIVATE
    "${FFX_VK_LIBRARY}" "${LIBYUV_LIBRARY}" Vulkan::Vulkan Boost::headers Threads::Threads)
