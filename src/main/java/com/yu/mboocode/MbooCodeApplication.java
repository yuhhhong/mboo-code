package com.yu.mboocode;

import com.yu.mboocode.common.util.AppDataPaths;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@MapperScan(basePackages = {"com.yu.mboocode.*.mapper"})
public class MbooCodeApplication {
    static void main(String[] args) {
        AppDataPaths.initialize();
        SpringApplication application = new SpringApplication(MbooCodeApplication.class);
        application.setHeadless(false);
        application.run(args);
    }
}
